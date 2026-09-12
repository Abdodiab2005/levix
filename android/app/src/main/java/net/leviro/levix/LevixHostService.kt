package net.leviro.levix

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Long-running host shell. Starts embedded Node from [ensureRunning].
 */
class LevixHostService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    private var wakeLock: PowerManager.WakeLock? = null
    private var running = false
    private var userStop = false
    private var tornDown = false
    private var unlisten: (() -> Unit)? = null
    private var nodeRetry = 0
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var isNetworkOnline = true
    private var offlineAlertPosted = false

    private val retryNode = Runnable {
        if (running && !userStop && HostPrefs.wantedRunning(this)) {
            NodeRuntime.start(this)
        }
    }

    private val heartbeat = object : Runnable {
        override fun run() {
            if (HostState.snapshot.running) HostState.heartbeat()
            checkStateAndNotify()
            handler.postDelayed(this, HEARTBEAT_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        // Promote immediately so a fast STOP still satisfies the FGS contract.
        startAsForeground(buildNotification(getString(R.string.notif_starting)))
        NodeRuntime.unexpectedExitListener = { code ->
            handler.post { scheduleNodeRetry(code) }
        }
        HostLog.event("service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                userStop = true
                HostPrefs.setWantedRunning(this, false)
                HostLog.event("service stop requested: user")
                teardown()
                stopSelf(startId)
                return START_NOT_STICKY
            }
            ACTION_START -> {
                HostPrefs.setWantedRunning(this, true)
                HostLog.event("service start: user")
                ensureRunning()
                return START_STICKY
            }
            else -> {
                if (!HostPrefs.wantedRunning(this)) {
                    HostLog.event("service start: system but user had stopped")
                    stopSelf(startId)
                    return START_NOT_STICKY
                }
                HostLog.event("service start: system restart")
                ensureRunning()
                return START_STICKY
            }
        }
    }

    override fun onDestroy() {
        if (!userStop) {
            HostLog.event("service stop: system")
        } else {
            HostLog.event("service stop: user")
        }
        NodeRuntime.unexpectedExitListener = null
        teardown()
        super.onDestroy()
    }

    private fun scheduleNodeRetry(code: Int) {
        if (userStop || tornDown || !HostPrefs.wantedRunning(this)) return
        if (nodeRetry >= NODE_RETRY_DELAYS_MS.size) {
            HostLog.event("node retry exhausted after exit $code")
            HostState.markNodeError("exited repeatedly")
            return
        }
        val delay = NODE_RETRY_DELAYS_MS[nodeRetry]
        nodeRetry += 1
        HostLog.event("node retry $nodeRetry in ${delay}ms (exit $code)")
        handler.removeCallbacks(retryNode)
        handler.postDelayed(retryNode, delay)
    }

    private fun ensureRunning() {
        if (running) return
        running = true
        tornDown = false
        userStop = false
        acquireWakeLock()
        registerNetworkCallback()
        HostState.markStarted()
        startAsForeground(buildNotification(getString(R.string.notif_starting)))
        handler.removeCallbacks(heartbeat)
        handler.postDelayed(heartbeat, HEARTBEAT_MS)
        unlisten?.invoke()
        unlisten = HostState.listen { snap ->
            if (snap.levixReady) nodeRetry = 0
            handler.post {
                if (running && !tornDown) checkStateAndNotify()
            }
        }
        NodeRuntime.start(this)
        checkStateAndNotify()
    }

    private fun teardown() {
        if (tornDown) return
        tornDown = true
        running = false
        handler.removeCallbacks(heartbeat)
        handler.removeCallbacks(retryNode)
        unlisten?.invoke()
        unlisten = null
        unregisterNetworkCallback()
        cancelOfflineAlert()
        NodeRuntime.stop()
        releaseWakeLock()
        HostState.markStopped()
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    /**
     * Partial (CPU) wake lock for the host lifetime so the 30s heartbeat can
     * run with the screen off. Not a full screen-on wake lock. Released on stop.
     */
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val lock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
        lock.setReferenceCounted(false)
        @Suppress("DEPRECATION")
        lock.acquire()
        wakeLock = lock
    }

    private fun releaseWakeLock() {
        val lock = wakeLock ?: return
        if (lock.isHeld) lock.release()
        wakeLock = null
    }

    private fun registerNetworkCallback() {
        if (connectivityManager != null) return
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        connectivityManager = cm

        val activeNet = cm.activeNetwork
        val caps = activeNet?.let { cm.getNetworkCapabilities(it) }
        isNetworkOnline = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                HostLog.event("network callback: available ($network)")
                handler.post {
                    isNetworkOnline = true
                    NodeRuntime.setNetworkOnline(true)
                    checkStateAndNotify()
                }
            }

            override fun onLost(network: Network) {
                HostLog.event("network callback: lost ($network)")
                handler.post {
                    isNetworkOnline = false
                    NodeRuntime.setNetworkOnline(false)
                    checkStateAndNotify()
                }
            }

            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                val hasInternet = networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                HostLog.event("network callback: capabilities internet=$hasInternet")
                handler.post {
                    if (isNetworkOnline != hasInternet) {
                        isNetworkOnline = hasInternet
                        NodeRuntime.setNetworkOnline(hasInternet)
                        checkStateAndNotify()
                    }
                }
            }
        }
        networkCallback = callback
        try {
            cm.registerDefaultNetworkCallback(callback)
        } catch (e: Exception) {
            HostLog.event("failed to register network callback: ${e.message}")
        }
    }

    private fun unregisterNetworkCallback() {
        val cm = connectivityManager ?: return
        val cb = networkCallback ?: return
        try {
            cm.unregisterNetworkCallback(cb)
        } catch (_: Exception) {}
        connectivityManager = null
        networkCallback = null
    }

    private fun startAsForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun formatWhatsAppStatus(snap: HostState.Snapshot): String {
        if (!isNetworkOnline) {
            return getString(R.string.notif_wa_offline)
        }
        val state = snap.whatsAppState ?: return getString(R.string.notif_node_starting)
        return when (state) {
            "connected" -> getString(R.string.notif_wa_connected)
            "paused" -> getString(R.string.notif_wa_paused)
            "waiting_for_qr" -> "WhatsApp: 📱 Waiting for pairing"
            "linking" -> "WhatsApp: 🔄 Linking…"
            "starting" -> "WhatsApp: ⏳ Starting…"
            "reconnecting" -> {
                val codeStr = snap.whatsAppCode?.let { " ($it: ${snap.whatsAppReason ?: "timeout"})" } ?: ""
                "WhatsApp: ⏳ Reconnecting$codeStr"
            }
            "retry_exhausted" -> {
                val codeStr = snap.whatsAppCode?.let { " ($it: ${snap.whatsAppReason ?: "timeout"})" } ?: ""
                "WhatsApp: ❌ Connection failed$codeStr"
            }
            "disconnected" -> {
                val codeStr = snap.whatsAppCode?.let { " ($it: ${snap.whatsAppReason ?: ""})" } ?: ""
                "WhatsApp: Disconnected$codeStr"
            }
            "logged_out" -> "WhatsApp: ⚠️ Logged out"
            "idle" -> "WhatsApp: ⏸️ Idle"
            else -> "WhatsApp: $state"
        }
    }

    private fun postOfflineAlert(title: String, message: String) {
        val openIntent = PendingIntent.getActivity(
            this,
            3,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(this, CHANNEL_ALERT_ID)
            .setSmallIcon(R.drawable.ic_stat_host)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.notif_open), openIntent)
            .build()

        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ALERT_ID, notif)
        offlineAlertPosted = true
    }

    private fun cancelOfflineAlert() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.cancel(NOTIFICATION_ALERT_ID)
        offlineAlertPosted = false
    }

    private fun checkStateAndNotify() {
        if (!running || tornDown) return
        val snap = HostState.snapshot

        if (!isNetworkOnline || snap.whatsAppState == "paused") {
            postOfflineAlert(
                getString(R.string.notif_offline_title),
                getString(R.string.notif_offline_network),
            )
        } else if (snap.whatsAppState in listOf("retry_exhausted", "error", "logged_out")) {
            val detail = when (snap.whatsAppState) {
                "logged_out" -> "Logged out. Tap to scan QR code."
                else -> {
                    val codeStr = snap.whatsAppCode?.let { "$it: " } ?: ""
                    val reasonStr = snap.whatsAppReason ?: "Connection failed"
                    "$codeStr$reasonStr"
                }
            }
            postOfflineAlert(
                getString(R.string.notif_offline_title),
                getString(R.string.notif_offline_wa, detail),
            )
        } else if (snap.whatsAppState == "connected") {
            cancelOfflineAlert()
        }

        updateNotification()
    }

    private fun updateNotification() {
        val snap = HostState.snapshot
        val waStatus = formatWhatsAppStatus(snap)
        val last = snap.lastHeartbeatMs
        val stamp = if (last == 0L) "—" else timeFormat.format(Date(last))
        val shortText = "$waStatus • $stamp"

        val node = when {
            snap.nodeError != null -> getString(R.string.notif_node_error, snap.nodeError)
            snap.levixReady -> getString(R.string.notif_levix_ready)
            snap.nodeVersion != null -> getString(
                R.string.notif_node_ok,
                snap.nodeVersion,
                snap.nodeArch ?: "?",
            )
            else -> getString(R.string.notif_node_starting)
        }
        val expandedText = "$waStatus\n${getString(R.string.notif_heartbeat, stamp)}\n$node"

        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(shortText, expandedText))
    }

    private fun buildNotification(shortText: String, expandedText: String = shortText): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            2,
            Intent(this, LevixHostService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_host)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(shortText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(expandedText))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.notif_open), openIntent)
            .addAction(0, getString(R.string.notif_stop), stopIntent)
            .build()
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notif_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.notif_channel_description)
                setShowBadge(false)
            }
            manager.createNotificationChannel(channel)
        }
        if (manager.getNotificationChannel(CHANNEL_ALERT_ID) == null) {
            val alertChannel = NotificationChannel(
                CHANNEL_ALERT_ID,
                getString(R.string.notif_alerts_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = getString(R.string.notif_alerts_channel_description)
                enableVibration(true)
                setShowBadge(true)
            }
            manager.createNotificationChannel(alertChannel)
        }
    }

    companion object {
        const val ACTION_START = "net.leviro.levix.action.START"
        const val ACTION_STOP = "net.leviro.levix.action.STOP"

        private const val CHANNEL_ID = "levix-host"
        const val CHANNEL_ALERT_ID = "levix-alerts"
        private const val NOTIFICATION_ID = 1001
        const val NOTIFICATION_ALERT_ID = 1002
        private const val HEARTBEAT_MS = 30_000L
        private val NODE_RETRY_DELAYS_MS = longArrayOf(5_000L, 10_000L, 15_000L, 20_000L, 25_000L)
        private const val WAKE_LOCK_TAG = "net.leviro.levix:host"

        fun start(context: Context) {
            val intent = Intent(context, LevixHostService::class.java).setAction(ACTION_START)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, LevixHostService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }
    }
}
