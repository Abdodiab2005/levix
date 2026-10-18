package net.leviro.levix

import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The only way the host log leaves the app, and only when the operator asks.
 *
 * Two routes: the share sheet (a one-off send to another app) and Downloads
 * (a copy that stays on the phone). Both read the same `host.log`; neither
 * adds anything to it.
 */
object HostLogShare {
    /** A Levix folder inside Downloads, so a saved log outlives an uninstall. */
    private const val DOWNLOADS_FOLDER = "Levix"

    private const val MIME_TEXT = "text/plain"

    fun hasLogs(context: Context): Boolean {
        val file = HostLog.getLogFile(context)
        return file.exists() && file.length() > 0L
    }

    fun share(activity: Activity) {
        val logFile = HostLog.getLogFile(activity)
        if (!logFile.exists() || logFile.length() == 0L) {
            Toast.makeText(activity, R.string.no_logs, Toast.LENGTH_SHORT).show()
            return
        }

        try {
            val uri: Uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                logFile,
            )
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = MIME_TEXT
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, "Levix Diagnostics Logs")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(Intent.createChooser(shareIntent, activity.getString(R.string.btn_share_logs)))
        } catch (_: Exception) {
            val text = HostLog.getFullLogText(activity)
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = MIME_TEXT
                putExtra(Intent.EXTRA_TEXT, text)
                putExtra(Intent.EXTRA_SUBJECT, "Levix Diagnostics Logs")
            }
            activity.startActivity(Intent.createChooser(shareIntent, activity.getString(R.string.btn_share_logs)))
        }
    }

    /**
     * Save and open in one tap: the copy is written first, so a device with no
     * text viewer still ends up with the file where it can be found.
     */
    suspend fun saveAndOpen(activity: Activity) {
        val name = displayName()
        val saved = withContext(Dispatchers.IO) {
            saveToDownloads(activity.applicationContext, name)
        }
        if (saved == null) {
            Toast.makeText(activity, R.string.no_logs, Toast.LENGTH_SHORT).show()
            return
        }
        Toast.makeText(
            activity,
            activity.getString(R.string.logs_saved_message, name),
            Toast.LENGTH_LONG,
        ).show()

        val openIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(saved, MIME_TEXT)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            activity.startActivity(openIntent)
        } catch (_: Exception) {
            Toast.makeText(activity, R.string.logs_open_missing, Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Copies the log into the public Downloads collection. Null when there is
     * nothing to save or the write failed — the caller says so instead of
     * pretending a file exists.
     */
    private fun saveToDownloads(context: Context, name: String): Uri? {
        val resolver = context.contentResolver
        var target: Uri? = null
        var published = false
        try {
            val source = HostLog.getLogFile(context)
            if (!source.exists() || source.length() == 0L) return null
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, MIME_TEXT)
                put(
                    MediaStore.MediaColumns.RELATIVE_PATH,
                    "${Environment.DIRECTORY_DOWNLOADS}/$DOWNLOADS_FOLDER",
                )
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return null
            target = uri
            val output = resolver.openOutputStream(uri) ?: return null
            output.use { sink -> source.inputStream().use { input -> input.copyTo(sink) } }

            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            if (resolver.update(uri, values, null, null) != 1) return null
            published = true
            return uri
        } catch (_: Exception) {
            return null
        } finally {
            if (!published) {
                target?.let { uri ->
                    // Cleanup must not turn an ordinary storage error into a crash.
                    try { resolver.delete(uri, null, null) } catch (_: Exception) { }
                }
            }
        }
    }

    /** The name a saved log gets, from a `yyyyMMdd-HHmmss` stamp. */
    fun savedFileName(stamp: String): String = "levix-host-$stamp.log"

    private fun displayName(): String =
        savedFileName(SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date()))
}
