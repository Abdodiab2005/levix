package net.leviro.levix

import android.view.LayoutInflater
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomsheet.BottomSheetDialog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * What the diagnostics card offers once tapped: keep the log, or send it.
 *
 * Two actions, both explicit. Nothing is uploaded, and the sheet never shows
 * log contents — the operator reads them where they chose to open or send them.
 */
object LogsActionsSheet {
    private var saveJob: Job? = null

    fun show(activity: AppCompatActivity) {
        val dialog = BottomSheetDialog(activity)
        val content = LayoutInflater.from(activity).inflate(R.layout.sheet_logs_actions, null)
        dialog.setContentView(content)
        dialog.setCanceledOnTouchOutside(true)

        val title = content.findViewById<TextView>(R.id.logsActionsTitle)
        val summary = content.findViewById<TextView>(R.id.logsActionsSummary)
        val saveOpen = content.findViewById<View>(R.id.logsActionSaveOpen)
        val share = content.findViewById<View>(R.id.logsActionShare)

        activity.lifecycleScope.launch {
            val hasLogs = withContext(Dispatchers.IO) {
                try { HostLogShare.hasLogs(activity.applicationContext) } catch (_: Exception) { false }
            }
            if (dialog.isShowing) {
                summary.setText(if (hasLogs) R.string.logs_actions_body else R.string.no_logs)
            }
        }
        val pendingSave = saveJob
        saveOpen.isEnabled = pendingSave == null
        val completion = pendingSave?.invokeOnCompletion {
            activity.runOnUiThread {
                if (!activity.isDestroyed) saveOpen.isEnabled = true
            }
        }
        dialog.setOnDismissListener { completion?.dispose() }

        row(
            saveOpen,
            activity.getString(R.string.logs_action_save_open),
            activity.getString(R.string.logs_action_save_open_sub),
        )
        row(
            share,
            activity.getString(R.string.logs_action_share),
            activity.getString(R.string.logs_action_share_sub),
        )

        saveOpen.setOnClickListener {
            if (saveJob != null) return@setOnClickListener
            saveOpen.isEnabled = false
            saveJob = activity.lifecycleScope.launch {
                try {
                    HostLogShare.saveAndOpen(activity)
                } finally {
                    saveJob = null
                    if (!activity.isDestroyed) {
                        saveOpen.isEnabled = true
                        dialog.dismiss()
                    }
                }
            }
        }
        share.setOnClickListener {
            dialog.dismiss()
            HostLogShare.share(activity)
        }

        ViewCompat.setAccessibilityHeading(title, true)
        dialog.show()
    }

    /**
     * A row that reads and announces itself like the button it behaves as. The
     * description carries both lines: a container description hides its
     * children from TalkBack.
     */
    private fun row(view: View, title: String, description: String) {
        view.contentDescription = "$title. $description"
        ViewCompat.setAccessibilityDelegate(view, object : AccessibilityDelegateCompat() {
            override fun onInitializeAccessibilityNodeInfo(
                host: View,
                info: AccessibilityNodeInfoCompat,
            ) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.className = "android.widget.Button"
            }
        })
    }
}
