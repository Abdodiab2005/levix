package net.leviro.levix

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/**
 * After reboot, BOOT_COMPLETED often fires before DNS/TLS work.
 * Wait for a validated default network before starting Node.
 */
object HostNetwork {
    fun isValidated(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    fun awaitValidated(context: Context, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (isValidated(context)) return true
            try {
                Thread.sleep(500L)
            } catch (_: InterruptedException) {
                break
            }
        }
        return isValidated(context)
    }
}
