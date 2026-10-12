package net.leviro.levix

import android.app.ActivityManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.StatFs
import android.webkit.WebView
import org.json.JSONObject

/** Native-only diagnostics. Each source fails independently and needs no permission prompt. */
object DeviceDiagnostics {
    const val UNKNOWN_JSON = "{\"nativeApp\":\"unknown\",\"android\":\"unknown\",\"device\":\"unknown\",\"abi\":\"unknown\",\"webview\":\"unknown\",\"connectivity\":\"unknown\",\"memory\":\"unknown\",\"storage\":\"unknown\"}"
    fun formatAndroid(release: String?, sdk: Int): String =
        if (release.isNullOrBlank() || sdk <= 0) "unknown" else capped("$release (API $sdk)", 40)

    fun formatDevice(manufacturer: String?, model: String?): String =
        if (manufacturer.isNullOrBlank() || model.isNullOrBlank()) "unknown"
        else capped("$manufacturer $model", 80)

    fun storageStatus(available: Long, total: Long): String =
        if (available < 0 || total <= 0) "unknown"
        else if (available < 500L * 1024 * 1024 || available.toDouble() / total < 0.10) "low"
        else "ok"

    private fun capped(value: String?, limit: Int): String =
        value?.trim()?.take(limit)?.ifEmpty { "unknown" } ?: "unknown"

    private fun value(limit: Int, block: () -> String?): String =
        try { capped(block(), limit) } catch (_: Exception) { "unknown" }

    fun collect(context: Context): Map<String, String> = linkedMapOf(
        "nativeApp" to value(40) {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            info.versionName?.let { "$it (${info.longVersionCode})" }
        },
        "android" to value(40) { formatAndroid(Build.VERSION.RELEASE, Build.VERSION.SDK_INT) },
        "device" to value(80) { formatDevice(Build.MANUFACTURER, Build.MODEL) },
        "abi" to value(24) { Build.SUPPORTED_ABIS.firstOrNull() },
        "webview" to value(40) { WebView.getCurrentWebViewPackage()?.versionName },
        "connectivity" to value(16) {
            val cm = context.getSystemService(ConnectivityManager::class.java)
            val network = cm?.activeNetwork
            if (cm == null) "unknown" else if (network == null) "none" else {
                val caps = cm.getNetworkCapabilities(network)
                when {
                    caps == null -> "unknown"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                    else -> "unknown"
                }
            }
        },
        "memory" to value(16) {
            val manager = context.getSystemService(ActivityManager::class.java) ?: return@value "unknown"
            val info = ActivityManager.MemoryInfo()
            manager.getMemoryInfo(info)
            if (info.lowMemory) "low" else "ok"
        },
        "storage" to value(16) {
            val stats = StatFs(HostState.dataDir(context).absolutePath)
            storageStatus(stats.availableBytes, stats.totalBytes)
        },
    )

    fun json(context: Context): String = try {
        JSONObject(collect(context)).toString()
    } catch (_: Exception) {
        UNKNOWN_JSON
    }
}
