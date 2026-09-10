package net.leviro.levix

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One Node.js child process. Unpacks the Levix JS bundle, then execs
 * `libnode.so` against `boot.mjs` from nativeLibraryDir (Android 10+ W^X).
 */
object NodeRuntime {
    private const val BINARY_NAME = "libnode.so"
    private const val STOP_GRACE_MS = 8_000L

    private val lock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val stopping = AtomicBoolean(false)
    private val starting = AtomicBoolean(false)

    @Volatile
    private var process: Process? = null

    @Volatile
    var unexpectedExitListener: ((Int) -> Unit)? = null

    fun start(context: Context) {
        val live = process
        if (live != null && live.isAlive) {
            HostLog.event("node start skipped: already running")
            return
        }
        if (!starting.compareAndSet(false, true)) return
        val app = context.applicationContext
        Thread({
            try {
                startBlocking(app)
            } catch (error: Exception) {
                val message = error.message ?: error.javaClass.simpleName
                HostLog.event("node start failed: $message")
                mainHandler.post {
                    HostState.markNodeError(message)
                    if (!stopping.get()) unexpectedExitListener?.invoke(-1)
                }
            } finally {
                starting.set(false)
            }
        }, "levix-node-start").start()
    }

    fun stop() {
        stopping.set(true)
        val live: Process?
        synchronized(lock) {
            live = process
        }
        if (live == null) return
        HostLog.event("node stop requested")
        live.destroy()
        val deadline = System.currentTimeMillis() + STOP_GRACE_MS
        while (live.isAlive && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(50L)
            } catch (_: InterruptedException) {
                break
            }
        }
        if (live.isAlive) {
            HostLog.event("node stop: sending SIGKILL")
            live.destroyForcibly()
        }
        synchronized(lock) {
            if (process === live) process = null
        }
    }

    fun isAlive(): Boolean {
        val live = process
        return live != null && live.isAlive
    }

    private fun startBlocking(app: Context) {
        val binary = File(app.applicationInfo.nativeLibraryDir, BINARY_NAME)
        if (!binary.exists()) {
            val message = "node binary missing at nativeLibraryDir/$BINARY_NAME"
            HostLog.event(message)
            mainHandler.post { HostState.markNodeError(message) }
            return
        }
        mainHandler.post { HostState.markNodeStarting() }
        val appDir = LevixAppBundle.ensure(app)
        if (HostNetwork.awaitValidated(app, 60_000L)) {
            HostLog.event("node start: network validated")
        } else {
            HostLog.event("node start: no validated network after 60s, continuing")
        }
        val boot = File(appDir, LevixAppBundle.BOOT_FILE)
        val dataDir = LevixAppBundle.dataDir(app)
        val builder = ProcessBuilder(binary.absolutePath, boot.absolutePath)
            .directory(appDir)
            .redirectErrorStream(true)
        val env = builder.environment()
        env["LEVIX_ANDROID"] = "1"
        env["LEVIX_DATA_DIR"] = dataDir.absolutePath
        env["LEVIX_OPEN_BROWSER"] = "0"
        env["HOME"] = dataDir.absolutePath
        env["TMPDIR"] = app.cacheDir.absolutePath
        env["NODE_DISABLE_COLORS"] = "1"
        env["LD_LIBRARY_PATH"] = app.applicationInfo.nativeLibraryDir
        val started = try {
            builder.start()
        } catch (error: Exception) {
            HostLog.event("node start failed: ${error.javaClass.simpleName}: ${error.message}")
            mainHandler.post { HostState.markNodeError(error.message ?: "start failed") }
            return
        }
        synchronized(lock) {
            process = started
        }
        HostLog.event("node started")
        Thread({ pumpOutput(started) }, "levix-node-out").apply { isDaemon = true }.start()
        Thread({ awaitExit(started) }, "levix-node-wait").apply { isDaemon = true }.start()
    }

    private fun pumpOutput(child: Process) {
        try {
            BufferedReader(InputStreamReader(child.inputStream, StandardCharsets.UTF_8)).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    handleLine(line)
                }
            }
        } catch (_: java.io.IOException) {
            // The pipe closes when Node is stopped.
        }
    }

    private fun handleLine(line: String) {
        when {
            line.startsWith("version ") -> {
                val version = line.removePrefix("version ").trim()
                HostLog.event("node $line")
                mainHandler.post { HostState.setNodeVersion(version) }
            }
            line.startsWith("platform ") -> {
                val platform = line.removePrefix("platform ").trim()
                HostLog.event("node $line")
                mainHandler.post { HostState.setNodePlatform(platform) }
            }
            line.startsWith("arch ") -> {
                val arch = line.removePrefix("arch ").trim()
                HostLog.event("node $line")
                mainHandler.post { HostState.setNodeArch(arch) }
            }
            line == "sqlite ok" -> {
                HostLog.event("node sqlite ok")
                mainHandler.post { HostState.markSqliteOk() }
            }
            line.startsWith("tls ok ") -> {
                HostLog.event("node $line")
                mainHandler.post { HostState.markTlsOk() }
            }
            line.startsWith("tls wait ") || line.startsWith("tls skipped ") || line.startsWith("tls error ") -> {
                HostLog.event("node $line")
            }
            line.startsWith("sqlite error ") -> {
                HostLog.event("node $line")
                mainHandler.post { HostState.markNodeError(line) }
            }
            line == "Database ready" -> {
                HostLog.event("node $line")
                mainHandler.post { HostState.markDatabaseReady() }
            }
            line.startsWith("Commands loaded ") -> {
                val count = line.removePrefix("Commands loaded ").trim().toIntOrNull()
                HostLog.event("node $line")
                mainHandler.post { HostState.markCommandsLoaded(count) }
            }
            line.startsWith("Panel listening ") -> {
                val url = line.removePrefix("Panel listening ").trim()
                HostLog.event("node $line")
                mainHandler.post { HostState.markPanelListening(url) }
            }
            line == "Levix ready" -> {
                HostLog.event("node $line")
                mainHandler.post {
                    HostState.markLevixReady()
                    HostState.heartbeat()
                }
            }
            line.startsWith("heartbeat ") -> {
                mainHandler.post {
                    HostState.heartbeat()
                    HostState.markNodeAlive()
                }
                HostLog.heartbeat(HostState.snapshot.heartbeatCount + 1L)
            }
            line.startsWith("pid ") -> HostLog.event("node $line")
            else -> {
                val trimmed = line.trim()
                if (trimmed.isEmpty() || looksSecret(trimmed)) return
                if (isNoisyLoggerLine(trimmed)) return
                HostLog.event("node: ${trimmed.take(200)}")
                mainHandler.post { HostState.setNodeLine(trimmed.take(200)) }
            }
        }
    }

    private fun awaitExit(child: Process) {
        val code = try {
            child.waitFor()
        } catch (_: InterruptedException) {
            -1
        }
        synchronized(lock) {
            if (process === child) process = null
        }
        val user = stopping.getAndSet(false)
        if (user) {
            HostLog.event("node exited after user stop code=$code")
            mainHandler.post { HostState.markNodeStopped() }
        } else {
            HostLog.event("node crashed code=$code")
            mainHandler.post {
                HostState.markNodeError("exited $code")
                unexpectedExitListener?.invoke(code)
            }
        }
    }

    private fun looksSecret(line: String): Boolean {
        val lower = stripAnsi(line).lowercase()
        return lower.contains("setup code") ||
            lower.contains("password") ||
            lower.contains("api key") ||
            lower.contains("token") ||
            lower.contains("secret")
    }

    private fun isNoisyLoggerLine(line: String): Boolean {
        val plain = stripAnsi(line)
        return plain.contains("INFO:") ||
            plain.contains("WARN:") ||
            plain.contains("DEBUG:") ||
            plain.contains("TRACE:")
    }

    private fun stripAnsi(line: String): String {
        return ANSI.replace(line, "")
    }

    private val ANSI = Regex("\u001B\\[[0-9;]*m")
}
