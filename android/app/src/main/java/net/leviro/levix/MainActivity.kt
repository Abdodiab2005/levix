package net.leviro.levix

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.os.LocaleListCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : AppCompatActivity() {
    private val uiHandler = Handler(Looper.getMainLooper())

    // Top Status Pill
    private lateinit var statusPill: View
    private lateinit var statusDot: View
    private lateinit var statusPillText: TextView
    private lateinit var btnLanguage: TextView

    // Hero Section
    private lateinit var heroSubtitleText: TextView
    private lateinit var panelButton: Button
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var statusHint: TextView

    // Status Overview Tiles
    private lateinit var cardWhatsApp: View
    private lateinit var whatsAppBadge: TextView
    private lateinit var whatsAppDetailText: TextView

    private lateinit var cardEngine: View
    private lateinit var engineBadge: TextView
    private lateinit var engineDetailText: TextView

    // Battery Guard
    private lateinit var cardBattery: View
    private lateinit var batteryIcon: ImageView
    private lateinit var batteryHint: TextView
    private lateinit var batteryBadge: TextView
    private lateinit var batteryButton: Button

    // Collapsible Diagnostics & Logs
    private lateinit var cardSignalsHeader: View
    private lateinit var diagnosticsHintText: TextView
    private lateinit var chevronLogs: ImageView
    private lateinit var diagnosticsContainer: View
    private lateinit var btnShareLogs: Button
    private lateinit var btnCopyLogs: Button
    private lateinit var logPathText: TextView
    private lateinit var consoleLogText: TextView

    private var isLogsExpanded = false

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
            statusHint.visibility = View.GONE
            LevixHostService.start(this)
        } else {
            statusHint.text = getString(R.string.notifications_required)
            statusHint.visibility = View.VISIBLE
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val root = findViewById<View>(R.id.rootScrollView)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(insets.left, insets.top, insets.right, insets.bottom)
            windowInsets
        }

        // Bind views
        statusPill = findViewById(R.id.statusPill)
        statusDot = findViewById(R.id.statusDot)
        statusPillText = findViewById(R.id.statusPillText)
        btnLanguage = findViewById(R.id.btnLanguage)

        val currentLocales = AppCompatDelegate.getApplicationLocales()
        val isArabic = if (!currentLocales.isEmpty) {
            currentLocales[0]?.language?.startsWith("ar") == true
        } else {
            resources.configuration.locales[0]?.language?.startsWith("ar") == true
        }
        btnLanguage.text = if (isArabic) "English" else "العربية"
        
        val cardLanguageSwitch = findViewById<View?>(R.id.cardLanguageSwitch)
        val btnLanguageToggleCard = findViewById<TextView?>(R.id.btnLanguageToggleCard)
        btnLanguageToggleCard?.text = if (isArabic) "English" else "العربية"

        val toggleLanguage = {
            val next = if (isArabic) "en" else "ar"
            AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(next))
        }
        btnLanguage.setOnClickListener { toggleLanguage() }
        cardLanguageSwitch?.setOnClickListener { toggleLanguage() }
        btnLanguageToggleCard?.setOnClickListener { toggleLanguage() }

        heroSubtitleText = findViewById(R.id.heroSubtitleText)
        panelButton = findViewById(R.id.panelButton)
        startButton = findViewById(R.id.startButton)
        stopButton = findViewById(R.id.stopButton)
        statusHint = findViewById(R.id.statusHint)

        cardWhatsApp = findViewById(R.id.cardWhatsApp)
        whatsAppBadge = findViewById(R.id.whatsAppBadge)
        whatsAppDetailText = findViewById(R.id.whatsAppDetailText)

        cardEngine = findViewById(R.id.cardEngine)
        engineBadge = findViewById(R.id.engineBadge)
        engineDetailText = findViewById(R.id.engineDetailText)

        cardBattery = findViewById(R.id.cardBattery)
        batteryIcon = findViewById(R.id.batteryIcon)
        batteryHint = findViewById(R.id.batteryHint)
        batteryBadge = findViewById(R.id.batteryBadge)
        batteryButton = findViewById(R.id.batteryButton)

        cardSignalsHeader = findViewById(R.id.cardSignalsHeader)
        diagnosticsHintText = findViewById(R.id.diagnosticsHintText)
        chevronLogs = findViewById(R.id.chevronLogs)
        diagnosticsContainer = findViewById(R.id.diagnosticsContainer)
        btnShareLogs = findViewById(R.id.btnShareLogs)
        btnCopyLogs = findViewById(R.id.btnCopyLogs)
        logPathText = findViewById(R.id.logPathText)
        consoleLogText = findViewById(R.id.consoleLogText)

        // Listeners
        startButton.setOnClickListener { requestStart() }
        stopButton.setOnClickListener { LevixHostService.stop(this) }
        panelButton.setOnClickListener { openPanel() }
        batteryButton.setOnClickListener { HostBattery.requestUnrestricted(this) }

        cardSignalsHeader.setOnClickListener {
            toggleLogsAccordion()
        }

        btnShareLogs.setOnClickListener {
            shareLogs()
        }

        btnCopyLogs.setOnClickListener {
            copyLogs()
        }

        render(HostState.snapshot)
        maybeAutostart(intent)
    }

    private fun toggleLogsAccordion() {
        isLogsExpanded = !isLogsExpanded
        diagnosticsContainer.visibility = if (isLogsExpanded) View.VISIBLE else View.GONE
        chevronLogs.setImageResource(
            if (isLogsExpanded) R.drawable.ic_chevron_up else R.drawable.ic_chevron_down
        )
        diagnosticsHintText.text = getString(
            if (isLogsExpanded) R.string.diagnostics_collapse_hint else R.string.diagnostics_expand_hint
        )
        if (isLogsExpanded) {
            renderDiagnostics()
        }
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
        if (intent?.getBooleanExtra(EXTRA_OPEN_PANEL, false) == true) {
            openPanel()
        }
    }

    private fun openPanel() {
        val url = HostState.snapshot.panelUrl ?: "http://127.0.0.1:3001/"
        startActivity(
            Intent(this, PanelActivity::class.java)
                .putExtra(PanelActivity.EXTRA_URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
    }

    override fun onResume() {
        super.onResume()
        render(HostState.snapshot)
    }

    override fun onStart() {
        super.onStart()
        uiHandler.post(refresh)
    }

    override fun onStop() {
        super.onStop()
        uiHandler.removeCallbacks(refresh)
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
        statusHint.visibility = View.GONE
        LevixHostService.start(this)
    }

    private fun shareLogs() {
        val logFile = HostLog.getLogFile(this)
        if (!logFile.exists() || logFile.length() == 0L) {
            Toast.makeText(this, R.string.no_logs, Toast.LENGTH_SHORT).show()
            return
        }

        try {
            val uri: Uri = FileProvider.getUriForFile(
                this,
                "${packageName}.fileprovider",
                logFile,
            )
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, "Levix Diagnostics Logs")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(shareIntent, "Share Levix Logs"))
        } catch (_: Exception) {
            val text = HostLog.getFullLogText(this)
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
                putExtra(Intent.EXTRA_SUBJECT, "Levix Diagnostics Logs")
            }
            startActivity(Intent.createChooser(shareIntent, "Share Levix Logs"))
        }
    }

    private fun copyLogs() {
        val text = HostLog.getFullLogText(this)
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Levix Host Logs", text)
        clipboard.setPrimaryClip(clip)
        Toast.makeText(this, R.string.logs_copied, Toast.LENGTH_SHORT).show()
    }

    private fun render(snapshot: HostState.Snapshot) {
        // 1. Top Status Pill
        renderStatusPill(snapshot)

        // 2. Hero Section
        renderHeroSection(snapshot)

        // 3. WhatsApp Tile
        renderWhatsAppTile(snapshot)

        // 4. Bot Engine Tile
        renderEngineTile(snapshot)

        // 5. Battery Protection Card
        renderBatteryCard()

        // 6. Diagnostics (if expanded)
        if (isLogsExpanded) {
            renderDiagnostics()
        }
    }

    private fun renderStatusPill(snapshot: HostState.Snapshot) {
        when {
            snapshot.whatsAppState == "connected" -> {
                statusDot.setBackgroundResource(R.drawable.ic_dot_green)
                statusPillText.text = getString(R.string.status_connected)
                statusPillText.setTextColor(ContextCompat.getColor(this, R.color.levix_ok))
            }
            snapshot.running -> {
                statusDot.setBackgroundResource(R.drawable.ic_dot_blue)
                statusPillText.text = getString(R.string.status_running)
                statusPillText.setTextColor(ContextCompat.getColor(this, R.color.levix_cyan))
            }
            else -> {
                statusDot.setBackgroundResource(R.drawable.ic_dot_red)
                statusPillText.text = getString(R.string.status_stopped)
                statusPillText.setTextColor(ContextCompat.getColor(this, R.color.levix_text_muted))
            }
        }
    }

    private fun renderHeroSection(snapshot: HostState.Snapshot) {
        if (snapshot.running) {
            heroSubtitleText.text = getString(R.string.hero_subtitle_running)
            startButton.isEnabled = false
            stopButton.isEnabled = true
            panelButton.isEnabled = snapshot.levixReady || snapshot.panelUrl != null
        } else {
            heroSubtitleText.text = getString(R.string.hero_subtitle_stopped)
            startButton.isEnabled = true
            stopButton.isEnabled = false
            panelButton.isEnabled = false
        }
    }

    private fun renderWhatsAppTile(snapshot: HostState.Snapshot) {
        if (!snapshot.running) {
            whatsAppBadge.text = getString(R.string.status_offline).uppercase()
            whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_text_muted))
            whatsAppDetailText.text = "Assistant stopped"
            return
        }

        when (snapshot.whatsAppState) {
            "connected" -> {
                whatsAppBadge.text = getString(R.string.status_connected).uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_ok))
                whatsAppDetailText.text = "Connected & active"
            }
            "waiting_for_qr" -> {
                whatsAppBadge.text = "LINK NEEDED"
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_warn))
                whatsAppDetailText.text = "Waiting for device pairing"
            }
            "paused" -> {
                whatsAppBadge.text = getString(R.string.status_paused).uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_warn))
                whatsAppDetailText.text = "Network paused"
            }
            "reconnecting" -> {
                whatsAppBadge.text = "RECONNECT".uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_warn))
                whatsAppDetailText.text = "Auto-reconnecting…"
            }
            "retry_exhausted" -> {
                whatsAppBadge.text = "FAILED"
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_danger))
                whatsAppDetailText.text = "Reconnection failed"
            }
            "logged_out" -> {
                whatsAppBadge.text = "EXPIRED"
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_danger))
                whatsAppDetailText.text = "Credentials expired"
            }
            else -> {
                whatsAppBadge.text = getString(R.string.status_starting).uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_cyan))
                whatsAppDetailText.text = "Connecting…"
            }
        }
    }

    private fun renderEngineTile(snapshot: HostState.Snapshot) {
        if (!snapshot.running) {
            engineBadge.text = getString(R.string.status_stopped).uppercase()
            engineBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_text_muted))
            engineDetailText.text = "Engine inactive"
            return
        }

        if (snapshot.levixReady) {
            engineBadge.text = getString(R.string.status_operational).uppercase()
            engineBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_ok))
            engineDetailText.text = "Core active & ready"
        } else {
            engineBadge.text = getString(R.string.status_starting).uppercase()
            engineBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_cyan))
            engineDetailText.text = "Initializing core…"
        }
    }

    private fun renderBatteryCard() {
        val unrestricted = HostBattery.isUnrestricted(this)
        if (unrestricted) {
            batteryBadge.text = getString(R.string.status_protected).uppercase()
            batteryBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_ok))
            batteryIcon.setColorFilter(ContextCompat.getColor(this, R.color.levix_ok))
            batteryHint.text = "Background protection active"
            batteryButton.visibility = View.GONE
        } else {
            batteryBadge.text = getString(R.string.status_restricted).uppercase()
            batteryBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_warn))
            batteryIcon.setColorFilter(ContextCompat.getColor(this, R.color.levix_warn))
            batteryHint.text = "Restricted by system. Protect 24/7 uptime."
            batteryButton.visibility = View.VISIBLE
            batteryButton.text = getString(R.string.btn_battery)
        }
    }

    private fun renderDiagnostics() {
        logPathText.text = getString(R.string.log_file_location, HostLog.getAccessiblePath(this))
        val recent = HostLog.readRecentLines(4)
        consoleLogText.text = recent.ifEmpty { getString(R.string.no_logs) }
    }

    companion object {
        const val EXTRA_AUTOSTART = "autostart"
        const val EXTRA_STOP = "autostop"
        const val EXTRA_OPEN_PANEL = "openPanel"
    }
}
