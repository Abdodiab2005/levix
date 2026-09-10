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
 * One Node.js child process, started from the host service.
 *
 * The binary is packaged as `libnode.so` under [android.content.pm.ApplicationInfo.nativeLibraryDir]
 * so Android 10+ W^X still allows exec. The heartbeat script is data, copied into filesDir.
 */
object NodeRuntime {
    private const val BINARY_NAME = "libnode.so"
    private const val SCRIPT_NAME = "heartbeat.js"
    private const val STOP_GRACE_MS = 3_000L

    private val lock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val stopping = AtomicBoolean(false)

    @Volatile
    private var process: Process? = null

    fun start(context: Context) {
        synchronized(lock) {
            val live = process
            if (live != null && live.isAlive) {
                HostLog.event("node start skipped: already running")
                return
            }
            stopping.set(false)
            val app = context.applicationContext
            val binary = File(app.applicationInfo.nativeLibraryDir, BINARY_NAME)
            if (!binary.exists()) {
                val message = "node binary missing at nativeLibraryDir/$BINARY_NAME"
                HostLog.event(message)
                mainHandler.post { HostState.markNodeError(message) }
                return
            }
            val script = copyScript(app)
            val builder = ProcessBuilder(binary.absolutePath, script.absolutePath)
                .directory(app.filesDir)
                .redirectErrorStream(true)
            val env = builder.environment()
            env["LEVIX_ANDROID"] = "1"
            env["LEVIX_DATA_DIR"] = app.filesDir.absolutePath
            env["HOME"] = app.filesDir.absolutePath
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
            process = started
            HostLog.event("node started")
            mainHandler.post { HostState.markNodeStarting() }
            Thread({ pumpOutput(started) }, "levix-node-out").apply { isDaemon = true }.start()
            Thread({ awaitExit(started) }, "levix-node-wait").apply { isDaemon = true }.start()
        }
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

    private fun copyScript(context: Context): File {
        val dir = File(context.filesDir, "runtime").apply { mkdirs() }
        val dest = File(dir, SCRIPT_NAME)
        context.assets.open(SCRIPT_NAME).use { input ->
            dest.outputStream().use { output -> input.copyTo(output) }
        }
        return dest
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
            line.startsWith("heartbeat ") -> {
                mainHandler.post {
                    HostState.heartbeat()
                    HostState.markNodeAlive()
                }
                HostLog.heartbeat(HostState.snapshot.heartbeatCount + 1L)
            }
            line.startsWith("pid ") -> HostLog.event("node $line")
            else -> {
                HostLog.event("node: $line")
                mainHandler.post { HostState.setNodeLine(line) }
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
            mainHandler.post { HostState.markNodeError("exited $code") }
        }
    }
}
