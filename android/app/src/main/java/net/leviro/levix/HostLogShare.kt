package net.leviro.levix

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.core.content.FileProvider

object HostLogShare {
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
                type = "text/plain"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, "Levix Diagnostics Logs")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(Intent.createChooser(shareIntent, activity.getString(R.string.btn_share_logs)))
        } catch (_: Exception) {
            val text = HostLog.getFullLogText(activity)
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
                putExtra(Intent.EXTRA_SUBJECT, "Levix Diagnostics Logs")
            }
            activity.startActivity(Intent.createChooser(shareIntent, activity.getString(R.string.btn_share_logs)))
        }
    }
}
