package net.leviro.levix

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restarts the host after reboot only if the user had left it running.
 * A previous Stop is sticky across reboot.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != ACTION_QUICKBOOT
        ) {
            return
        }
        HostLog.init(context)
        if (!HostPrefs.wantedRunning(context)) {
            HostLog.event("boot: skip, user had stopped the host")
            return
        }
        HostLog.event("boot: starting host")
        LevixHostService.start(context)
    }

    companion object {
        // Xiaomi / some OEMs fire this instead of (or as well as) BOOT_COMPLETED.
        private const val ACTION_QUICKBOOT = "android.intent.action.QUICKBOOT_POWERON"
    }
}
