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
 * Host-only log. Events go to logcat and to `filesDir/host.log`.
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
    private var file: File? = null

    fun init(context: Context) {
        synchronized(lock) {
            file = File(context.applicationContext.filesDir, FILE_NAME)
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

    private fun append(level: String, message: String) {
        val line = "${timestamp.format(Date())} $level $message\n"
        synchronized(lock) {
            val target = file ?: return
            try {
                FileOutputStream(target, true).use { out ->
                    out.write(line.toByteArray(StandardCharsets.UTF_8))
                }
            } catch (error: Exception) {
                Log.w(TAG, "host.log write failed", error)
            }
        }
    }
}
