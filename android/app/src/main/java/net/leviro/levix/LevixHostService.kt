package net.leviro.levix

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
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

    private val heartbeat = object : Runnable {
        override fun run() {
            updateNotification()
            handler.postDelayed(this, HEARTBEAT_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        // Promote immediately so a fast STOP still satisfies the FGS contract.
        startAsForeground(buildNotification(getString(R.string.notif_starting)))
        HostLog.event("service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                userStop = true
                HostLog.event("service stop requested: user")
                teardown()
                stopSelf(startId)
                return START_NOT_STICKY
            }
            ACTION_START -> {
                HostLog.event("service start: user")
                ensureRunning()
                return START_STICKY
            }
            else -> {
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
        teardown()
        super.onDestroy()
    }

    private fun ensureRunning() {
        if (running) return
        running = true
        tornDown = false
        userStop = false
        acquireWakeLock()
        HostState.markStarted()
        startAsForeground(buildNotification(heartbeatLine()))
        handler.removeCallbacks(heartbeat)
        handler.postDelayed(heartbeat, HEARTBEAT_MS)
        unlisten?.invoke()
        unlisten = HostState.listen {
            handler.post {
                if (running && !tornDown) updateNotification()
            }
        }
        NodeRuntime.start(this)
    }

    private fun teardown() {
        if (tornDown) return
        tornDown = true
        running = false
        handler.removeCallbacks(heartbeat)
        unlisten?.invoke()
        unlisten = null
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

    private fun updateNotification() {
        val text = heartbeatLine()
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun heartbeatLine(): String {
        val snap = HostState.snapshot
        val last = snap.lastHeartbeatMs
        val stamp = if (last == 0L) "—" else timeFormat.format(Date(last))
        val node = when {
            snap.nodeError != null -> getString(R.string.notif_node_error, snap.nodeError)
            snap.nodeVersion != null -> getString(
                R.string.notif_node_ok,
                snap.nodeVersion,
                snap.nodeArch ?: "?",
            )
            else -> getString(R.string.notif_node_starting)
        }
        return getString(R.string.notif_heartbeat, stamp) + "\n" + node
    }

    private fun buildNotification(text: String): Notification {
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
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
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
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
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

    companion object {
        const val ACTION_START = "net.leviro.levix.action.START"
        const val ACTION_STOP = "net.leviro.levix.action.STOP"

        private const val CHANNEL_ID = "levix-host"
        private const val NOTIFICATION_ID = 1001
        private const val HEARTBEAT_MS = 30_000L
        private const val WAKE_LOCK_TAG = "net.leviro.levix:host"

        fun start(context: Context) {
            val intent = Intent(context, LevixHostService::class.java).setAction(ACTION_START)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            if (!HostState.snapshot.running) return
            val intent = Intent(context, LevixHostService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }
    }
}
