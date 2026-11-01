package net.leviro.levix

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.annotation.StringRes
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
    private var powerReceiver: BroadcastReceiver? = null

    private val retryNode = Runnable {
        if (running && !userStop && HostPrefs.wantedRunning(this)) {
            NodeRuntime.start(this)
        }
    }

    private val heartbeat = object : Runnable {
        override fun run() {
            if (HostState.snapshot.running) {
                HostState.heartbeat()
                // Every 10th beat (5 min) reaches host.log. The delay runs on
                // uptime, which stops while the CPU sleeps, so a phone that
                // froze Levix shows up as a gap between these lines.
                HostLog.heartbeat(HostState.snapshot.heartbeatCount)
            }
            checkStateAndNotify()
            handler.postDelayed(this, HEARTBEAT_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        ensureChannel()
        checkStateAndNotify()
    }

    // AppCompat's app language can differ from a Service's resources on API
    // 29 to 32: the system still delivers configuration changes to the
    // service on those versions, but for system config switches, not for an
    // app language set in the panel. Resolve strings at notification time so
    // the heartbeat also refreshes an already-running notification after an
    // in-app language change, and the hook in UiPrefs.onLanguageApplied
    // (registered in onCreate) covers the versions where nothing else does.
    private fun localizedString(@StringRes id: Int, vararg args: Any): String {
        val config = Configuration(resources.configuration)
        config.setLocale(Locale.forLanguageTag(UiPrefs.language(this)))
        return createConfigurationContext(config).getString(id, *args)
    }

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        // In-app language change on API 29 to 32: nothing would otherwise tell
        // a running service that the app language moved, so this redraws the
        // channel and the visible notification straight after the switch
        // (UiPrefs.set fires the hook from the language branch).
        UiPrefs.onLanguageApplied = { handler.post {
            ensureChannel()
            checkStateAndNotify()
        } }
        // Promote immediately so a fast STOP still satisfies the FGS contract.
        startAsForeground(buildNotification(localizedString(R.string.notif_starting)))
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
        UiPrefs.onLanguageApplied = null
        teardown()
        super.onDestroy()
    }

    private fun scheduleNodeRetry(code: Int) {
        if (userStop || tornDown || !HostPrefs.wantedRunning(this)) return
        if (code == DATA_UNAVAILABLE_EXIT_CODE) {
            HostLog.event("node stopped: data directory needs attention (exit 78)")
            HostPrefs.setWantedRunning(this, false)
            handler.removeCallbacks(retryNode)
            HostState.markNodeError(localizedString(R.string.host_data_unavailable))
            return
        }
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
        registerPowerReceiver()
        registerNetworkCallback()
        HostState.markStarted()
        startAsForeground(buildNotification(localizedString(R.string.notif_starting)))
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
        unregisterPowerReceiver()
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

    /**
     * Puts the phone's power state in host.log: whether Levix is exempt from
     * battery optimization, and every Doze / battery-saver switch. Without the
     * exemption Doze ignores the wake lock above — the process freezes, the
     * WhatsApp keepalive stops, and the 5-second reconnect timer fires minutes
     * later — which a log of reconnects alone can't tell apart from a bad
     * network.
     */
    private fun registerPowerReceiver() {
        if (powerReceiver != null) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        HostLog.event(
            "power: battery unrestricted=${HostBattery.isUnrestricted(this)} " +
                "saver=${pm.isPowerSaveMode} doze=${pm.isDeviceIdleMode}",
        )
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                when (intent.action) {
                    PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED ->
                        HostLog.event("power: doze=${pm.isDeviceIdleMode}")
                    PowerManager.ACTION_POWER_SAVE_MODE_CHANGED ->
                        HostLog.event("power: saver=${pm.isPowerSaveMode}")
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED)
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        }
        // System broadcasts still arrive at a not-exported receiver.
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        powerReceiver = receiver
    }

    private fun unregisterPowerReceiver() {
        val receiver = powerReceiver ?: return
        try {
            unregisterReceiver(receiver)
        } catch (_: Exception) {}
        powerReceiver = null
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
                handler.post {
                    // Android calls this on every signal-strength or bandwidth
                    // update — a quarter of host.log was the same line — so
                    // only an actual change is logged.
                    if (isNetworkOnline != hasInternet) {
                        HostLog.event("network callback: capabilities internet=$hasInternet")
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

    private var cachedLargeIcon: Bitmap? = null

    private fun getLevixLargeIcon(): Bitmap? {
        cachedLargeIcon?.let { return it }
        return try {
            val drawable = ContextCompat.getDrawable(this, R.drawable.ic_levix_mark) ?: return null
            val density = resources.displayMetrics.density
            val size = (64 * density).toInt().coerceAtLeast(64)
            val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            drawable.setBounds(0, 0, canvas.width, canvas.height)
            drawable.draw(canvas)
            cachedLargeIcon = bitmap
            bitmap
        } catch (_: Exception) {
            null
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
        val largeIcon = getLevixLargeIcon()
        val builder = NotificationCompat.Builder(this, CHANNEL_ALERT_ID)
            .setSmallIcon(R.drawable.ic_stat_host)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setColor(ContextCompat.getColor(this, R.color.levix_warn))
            .setAutoCancel(true)
            .setContentIntent(openIntent)
            .addAction(0, localizedString(R.string.notif_open), openIntent)

        if (largeIcon != null) {
            builder.setLargeIcon(largeIcon)
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ALERT_ID, builder.build())
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
                localizedString(R.string.notif_offline_title),
                localizedString(R.string.notif_offline_network),
            )
        } else if (snap.whatsAppState in listOf("retry_exhausted", "error", "logged_out")) {
            val detail = when (snap.whatsAppState) {
                "logged_out" -> localizedString(R.string.card_whatsapp_desc_expired_long)
                else -> {
                    val codeStr = snap.whatsAppCode?.let { "$it: " } ?: ""
                    val reasonStr = snap.whatsAppReason ?: localizedString(R.string.card_whatsapp_desc_failed)
                    "$codeStr$reasonStr"
                }
            }
            postOfflineAlert(
                localizedString(R.string.notif_offline_title),
                localizedString(R.string.notif_offline_wa, detail),
            )
        } else if (snap.whatsAppState == "connected") {
            cancelOfflineAlert()
        }

        updateNotification()
    }

    private fun updateNotification() {
        val snap = HostState.snapshot

        val statusLabel = when {
            !isNetworkOnline || snap.whatsAppState == "paused" -> R.string.status_paused
            snap.whatsAppState == "connected" -> R.string.status_connected
            snap.whatsAppState == "waiting_for_qr" -> R.string.status_pairing
            snap.whatsAppState == "reconnecting" -> R.string.status_reconnecting
            snap.whatsAppState == "retry_exhausted" -> R.string.status_failed
            snap.whatsAppState == "logged_out" -> R.string.status_expired
            snap.whatsAppState == "error" -> R.string.wa_detail_error
            snap.whatsAppState == "disconnected" -> R.string.status_offline
            snap.whatsAppState == "idle" -> R.string.status_stopped
            snap.whatsAppState in listOf("starting", "linking") -> R.string.notif_starting
            snap.running -> R.string.notif_starting
            else -> R.string.status_stopped
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(localizedString(statusLabel)))
    }

    private fun buildNotification(statusText: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val panelIntent = PendingIntent.getActivity(
            this,
            2,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(MainActivity.EXTRA_OPEN_PANEL, true)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            3,
            Intent(this, LevixHostService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val largeIcon = getLevixLargeIcon()

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_host)
            .setContentTitle(statusText)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setColor(ContextCompat.getColor(this, R.color.levix_blue))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openIntent)
            .addAction(0, localizedString(R.string.btn_open_panel), panelIntent)
            .addAction(0, localizedString(R.string.notif_stop), stopIntent)

        if (largeIcon != null) {
            builder.setLargeIcon(largeIcon)
        }

        return builder.build()
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java)

        // Reset existing channels if they had sound or vibration enabled
        val existingHost = manager.getNotificationChannel(CHANNEL_ID)
        if (existingHost != null && (existingHost.importance > NotificationManager.IMPORTANCE_LOW || existingHost.sound != null || existingHost.shouldVibrate())) {
            manager.deleteNotificationChannel(CHANNEL_ID)
        }
        val existingAlert = manager.getNotificationChannel(CHANNEL_ALERT_ID)
        if (existingAlert != null && (existingAlert.importance > NotificationManager.IMPORTANCE_LOW || existingAlert.sound != null || existingAlert.shouldVibrate())) {
            manager.deleteNotificationChannel(CHANNEL_ALERT_ID)
        }

        // A channel follows the app language: createNotificationChannel with
        // the same id updates the name and description in place, and the
        // user's importance and sound choices are kept. Never delete a channel
        // to rename it: that throws on recent Android versions while a
        // foreground service notification is posted on it.
        val channel = NotificationChannel(
            CHANNEL_ID,
            localizedString(R.string.notif_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = localizedString(R.string.notif_channel_description)
            setShowBadge(false)
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
        val alertChannel = NotificationChannel(
            CHANNEL_ALERT_ID,
            localizedString(R.string.notif_alerts_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = localizedString(R.string.notif_alerts_channel_description)
            setShowBadge(false)
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(alertChannel)
    }

    companion object {
        const val ACTION_START = "net.leviro.levix.action.START"
        const val ACTION_STOP = "net.leviro.levix.action.STOP"

        private const val CHANNEL_ID = "levix-host"
        const val CHANNEL_ALERT_ID = "levix-alerts"
        private const val NOTIFICATION_ID = 1001
        const val NOTIFICATION_ALERT_ID = 1002
        private const val HEARTBEAT_MS = 30_000L
        private const val DATA_UNAVAILABLE_EXIT_CODE = 78
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
