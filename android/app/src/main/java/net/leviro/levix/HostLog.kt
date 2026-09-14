package net.leviro.levix

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Host-only log. Events go to logcat, private `filesDir/host.log`, and are
 * mirrored to accessible external app storage `getExternalFilesDir("logs")/host.log`
 * so users can reach them via any file manager or USB connection during beta/rc.
 *
 * Do not write WhatsApp auth, API keys, panel passwords, pairing codes,
 * or the contents of Levix data files here.
 */
object HostLog {
    private const val TAG = "LevixHost"
    private const val FILE_NAME = "host.log"

    private val lock = Any()
    private val timestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    @Volatile
    private var internalFile: File? = null

    @Volatile
    private var externalFile: File? = null

    fun init(context: Context) {
        val app = context.applicationContext
        synchronized(lock) {
            internalFile = File(app.filesDir, FILE_NAME)
            try {
                val extDir = app.getExternalFilesDir("logs")
                if (extDir != null) {
                    extDir.mkdirs()
                    externalFile = File(extDir, FILE_NAME)
                }
            } catch (error: Exception) {
                Log.w(TAG, "Failed to initialize external logs: ${error.message}")
            }
        }
    }

    fun event(message: String) {
        Log.i(TAG, message)
        append("I", message)
    }

    fun heartbeat(count: Long) {
        Log.d(TAG, "heartbeat #$count")
        if (count == 1L || count % 10L == 0L) {
            append("I", "heartbeat #$count")
        }
    }

    fun crash(error: Throwable) {
        Log.e(TAG, "crash", error)
        val stack = error.stackTraceToString().lineSequence().take(12).joinToString(" | ")
        append("E", "crash: $stack")
    }

    /**
     * Returns the primary readable log file (external if accessible, otherwise internal).
     */
    fun getLogFile(context: Context): File {
        val app = context.applicationContext
        synchronized(lock) {
            val ext = externalFile ?: File(app.getExternalFilesDir("logs") ?: app.filesDir, FILE_NAME)
            if (ext.exists() && ext.length() > 0L) return ext
            val internal = internalFile ?: File(app.filesDir, FILE_NAME)
            if (internal.exists()) {
                // Ensure external has a fresh copy
                try {
                    val target = File(app.getExternalFilesDir("logs") ?: app.filesDir, FILE_NAME)
                    internal.copyTo(target, overwrite = true)
                    return target
                } catch (_: Exception) {
                    return internal
                }
            }
            return ext
        }
    }

    /**
     * Human-readable relative path for display in UI.
     */
    fun getAccessiblePath(context: Context): String {
        val ext = context.applicationContext.getExternalFilesDir("logs")
        return if (ext != null) {
            "Android/data/net.leviro.levix/files/logs/host.log"
        } else {
            "Internal Storage/files/host.log"
        }
    }

    fun readRecentLines(maxLines: Int = 5): String {
        val target = externalFile?.takeIf { it.exists() } ?: internalFile?.takeIf { it.exists() } ?: return ""
        return try {
            target.readLines(StandardCharsets.UTF_8).takeLast(maxLines).joinToString("\n")
        } catch (_: Exception) {
            ""
        }
    }

    fun getFullLogText(context: Context): String {
        val file = getLogFile(context)
        if (!file.exists() || file.length() == 0L) return "No host log entries recorded yet."
        return try {
            file.readText(StandardCharsets.UTF_8).takeLast(128_000)
        } catch (e: Exception) {
            "Error reading log: ${e.message}"
        }
    }

    private fun append(level: String, message: String) {
        val line = "${timestamp.format(Date())} $level $message\n"
        val bytes = line.toByteArray(StandardCharsets.UTF_8)
        synchronized(lock) {
            internalFile?.let { target ->
                try {
                    FileOutputStream(target, true).use { it.write(bytes) }
                } catch (error: Exception) {
                    Log.w(TAG, "internal host.log write failed", error)
                }
            }
            externalFile?.let { target ->
                try {
                    FileOutputStream(target, true).use { it.write(bytes) }
                } catch (error: Exception) {
                    Log.w(TAG, "external host.log write failed", error)
                }
            }
        }
    }
}
