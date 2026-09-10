package net.leviro.levix

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private val uiHandler = Handler(Looper.getMainLooper())
    private var unlisten: (() -> Unit)? = null

    private lateinit var statusText: TextView
    private lateinit var heartbeatText: TextView
    private lateinit var nodeText: TextView
    private lateinit var levixText: TextView
    private lateinit var statusHint: TextView
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var panelButton: Button

    private val refresh = object : Runnable {
        override fun run() {
            render(HostState.snapshot)
            uiHandler.postDelayed(this, 1_000L)
        }
    }

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            statusHint.text = ""
            LevixHostService.start(this)
        } else {
            statusHint.text = getString(R.string.notifications_required)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        heartbeatText = findViewById(R.id.heartbeatText)
        nodeText = findViewById(R.id.nodeText)
        levixText = findViewById(R.id.levixText)
        statusHint = findViewById(R.id.statusHint)
        startButton = findViewById(R.id.startButton)
        stopButton = findViewById(R.id.stopButton)
        panelButton = findViewById(R.id.panelButton)

        panelButton.isEnabled = false
        startButton.setOnClickListener { requestStart() }
        stopButton.setOnClickListener { LevixHostService.stop(this) }
        render(HostState.snapshot)
        maybeAutostart(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        maybeAutostart(intent)
    }

    private fun maybeAutostart(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_STOP, false) == true) {
            LevixHostService.stop(this)
            return
        }
        if (intent?.getBooleanExtra(EXTRA_AUTOSTART, false) == true) {
            requestStart()
        }
    }

    override fun onStart() {
        super.onStart()
        unlisten = HostState.listen { snapshot ->
            runOnUiThread { render(snapshot) }
        }
        uiHandler.post(refresh)
    }

    override fun onStop() {
        unlisten?.invoke()
        unlisten = null
        uiHandler.removeCallbacks(refresh)
        super.onStop()
    }

    private fun requestStart() {
        if (Build.VERSION.SDK_INT >= 33) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                return
            }
        }
        statusHint.text = ""
        LevixHostService.start(this)
    }

    private fun render(snapshot: HostState.Snapshot) {
        statusText.text = if (snapshot.running) {
            getString(R.string.status_running)
        } else {
            getString(R.string.status_stopped)
        }
        heartbeatText.text = if (!snapshot.running || snapshot.lastHeartbeatMs == 0L) {
            getString(R.string.heartbeat_none)
        } else {
            getString(R.string.heartbeat_ago, formatAge(snapshot.lastHeartbeatMs))
        }
        nodeText.text = when {
            snapshot.nodeError != null -> getString(R.string.node_error, snapshot.nodeError)
            snapshot.nodeVersion != null -> getString(
                R.string.node_ok,
                snapshot.nodeVersion,
                snapshot.nodePlatform ?: "?",
                snapshot.nodeArch ?: "?",
            )
            snapshot.running -> getString(R.string.node_starting)
            else -> getString(R.string.node_none)
        }
        levixText.text = levixStatus(snapshot)
        startButton.isEnabled = !snapshot.running
        stopButton.isEnabled = snapshot.running
        panelButton.isEnabled = false
    }

    private fun levixStatus(snapshot: HostState.Snapshot): String {
        if (!snapshot.running) return ""
        val parts = mutableListOf<String>()
        if (snapshot.levixReady) parts.add(getString(R.string.levix_ready))
        if (snapshot.databaseReady) parts.add(getString(R.string.levix_db))
        snapshot.commandsLoaded?.let { parts.add(getString(R.string.levix_commands, it)) }
        snapshot.panelUrl?.let { parts.add(getString(R.string.levix_panel, it)) }
        if (snapshot.sqliteOk && parts.isEmpty()) parts.add(getString(R.string.levix_sqlite))
        if (parts.isEmpty()) parts.add(getString(R.string.levix_unpacking))
        return parts.joinToString("\n")
    }

    private fun formatAge(epochMs: Long): String {
        val seconds = ((System.currentTimeMillis() - epochMs) / 1000L).coerceAtLeast(0L)
        return when {
            seconds < 60L -> getString(R.string.age_seconds, seconds)
            seconds < 3600L -> getString(R.string.age_minutes, seconds / 60L)
            else -> getString(R.string.age_hours, seconds / 3600L)
        }
    }

    companion object {
        const val EXTRA_AUTOSTART = "autostart"
        const val EXTRA_STOP = "autostop"
    }
}
