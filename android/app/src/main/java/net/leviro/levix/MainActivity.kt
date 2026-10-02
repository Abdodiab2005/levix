package net.leviro.levix

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.TextView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.ContextCompat
import androidx.core.os.LocaleListCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : AppCompatActivity() {
    private val uiHandler = Handler(Looper.getMainLooper())

    // Top Status Pill
    private lateinit var statusPill: View
    private lateinit var statusDot: View
    private lateinit var statusPillText: TextView
    private lateinit var btnLanguage: View

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

    // Diagnostics & Logs
    private lateinit var btnShareLogs: Button

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
        // Edge-to-edge on every Android version, not only the 15+ that force
        // it; the root pads itself from the insets below. Levix is dark in
        // either system theme, so the bar icons stay light.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
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
        
        val cardLanguageSwitch = findViewById<View?>(R.id.cardLanguageSwitch)
        val btnLanguageToggleCard = findViewById<TextView?>(R.id.btnLanguageToggleCard)
        btnLanguageToggleCard?.text = if (isArabic) "العربية" else "English"

        val showLanguageDialog = {
            val languages = arrayOf(getString(R.string.lang_arabic), getString(R.string.lang_english))
            val languageTags = arrayOf("ar", "en")
            val locales = AppCompatDelegate.getApplicationLocales()
            val isCurrentAr = if (!locales.isEmpty) {
                locales[0]?.language?.startsWith("ar") == true
            } else {
                resources.configuration.locales[0]?.language?.startsWith("ar") == true
            }
            val currentIndex = if (isCurrentAr) 0 else 1

            com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
                .setTitle(R.string.dialog_choose_language)
                .setSingleChoiceItems(languages, currentIndex) { dialog, which ->
                    dialog.dismiss()
                    if (which != currentIndex) {
                        val targetTag = languageTags[which]
                        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(targetTag))
                    }
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }

        btnLanguage.setOnClickListener { showLanguageDialog() }
        cardLanguageSwitch?.setOnClickListener { showLanguageDialog() }
        btnLanguageToggleCard?.setOnClickListener { showLanguageDialog() }

        heroSubtitleText = findViewById(R.id.heroSubtitleText)
        panelButton = findViewById(R.id.panelButton)
        startButton = findViewById(R.id.startButton)
        stopButton = findViewById(R.id.stopButton)
        statusHint = findViewById(R.id.statusHint)

        cardWhatsApp = findViewById(R.id.cardWhatsApp)
        whatsAppBadge = findViewById(R.id.whatsAppBadge)
        whatsAppDetailText = findViewById(R.id.whatsAppDetailText)
        cardWhatsApp.setOnClickListener { openPanelAt("connection") }

        cardEngine = findViewById(R.id.cardEngine)
        engineBadge = findViewById(R.id.engineBadge)
        engineDetailText = findViewById(R.id.engineDetailText)

        cardBattery = findViewById(R.id.cardBattery)
        batteryIcon = findViewById(R.id.batteryIcon)
        batteryHint = findViewById(R.id.batteryHint)
        batteryBadge = findViewById(R.id.batteryBadge)
        batteryButton = findViewById(R.id.batteryButton)

        btnShareLogs = findViewById(R.id.btnShareLogs)

        // Listeners
        startButton.setOnClickListener { requestStart() }
        stopButton.setOnClickListener { LevixHostService.stop(this) }
        panelButton.setOnClickListener { openPanel() }
        batteryButton.setOnClickListener { HostBattery.requestUnrestricted(this) }

        btnShareLogs.setOnClickListener {
            HostLogShare.share(this)
        }

        render(HostState.snapshot)
        maybeOpenPanel(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        maybeOpenPanel(intent)
    }

    // MainActivity must remain exported for the launcher. Never accept service
    // start/stop controls through its extras: another installed app can launch
    // an exported activity with arbitrary extras. The notification's harmless
    // "open panel" navigation is the only action routed through this activity.
    private fun maybeOpenPanel(intent: Intent?) {
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

    private fun openPanelAt(hash: String) {
        val base = HostState.snapshot.panelUrl ?: "http://127.0.0.1:3001/"
        val url = base.trimEnd('/') + "/#" + hash
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
            whatsAppDetailText.text = getString(R.string.card_whatsapp_desc_offline)
            return
        }

        when (snapshot.whatsAppState) {
            "connected" -> {
                whatsAppBadge.text = getString(R.string.status_connected).uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_ok))
                whatsAppDetailText.text = getString(R.string.card_whatsapp_desc_connected_short)
            }
            "waiting_for_qr" -> {
                whatsAppBadge.text = getString(R.string.status_pairing).uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_warn))
                whatsAppDetailText.text = getString(R.string.card_whatsapp_desc_pairing_short)
            }
            "paused" -> {
                whatsAppBadge.text = getString(R.string.status_paused).uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_warn))
                whatsAppDetailText.text = getString(R.string.card_whatsapp_desc_paused_short)
            }
            "reconnecting" -> {
                whatsAppBadge.text = getString(R.string.status_reconnecting).uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_warn))
                whatsAppDetailText.text = getString(R.string.card_whatsapp_desc_reconnecting_short)
            }
            "retry_exhausted" -> {
                whatsAppBadge.text = getString(R.string.status_failed).uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_danger))
                whatsAppDetailText.text = getString(R.string.card_whatsapp_desc_failed)
            }
            "logged_out" -> {
                whatsAppBadge.text = getString(R.string.status_expired).uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_danger))
                whatsAppDetailText.text = getString(R.string.card_whatsapp_desc_expired)
            }
            else -> {
                whatsAppBadge.text = getString(R.string.status_starting).uppercase()
                whatsAppBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_cyan))
                whatsAppDetailText.text = getString(R.string.card_whatsapp_desc_connecting)
            }
        }
    }

    private fun renderEngineTile(snapshot: HostState.Snapshot) {
        if (!snapshot.running) {
            engineBadge.text = getString(R.string.status_stopped).uppercase()
            engineBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_text_muted))
            engineDetailText.text = getString(R.string.card_engine_desc_stopped_short)
            return
        }

        if (snapshot.levixReady) {
            engineBadge.text = getString(R.string.status_operational).uppercase()
            engineBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_ok))
            engineDetailText.text = getString(R.string.card_engine_desc_running_short)
        } else {
            engineBadge.text = getString(R.string.status_starting).uppercase()
            engineBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_cyan))
            engineDetailText.text = getString(R.string.card_engine_desc_starting_short)
        }
    }

    private fun renderBatteryCard() {
        val unrestricted = HostBattery.isUnrestricted(this)
        if (unrestricted) {
            batteryBadge.text = getString(R.string.status_protected).uppercase()
            batteryBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_ok))
            batteryIcon.setColorFilter(ContextCompat.getColor(this, R.color.levix_ok))
            batteryHint.text = getString(R.string.battery_ok_short)
            batteryButton.visibility = View.GONE
        } else {
            batteryBadge.text = getString(R.string.status_restricted).uppercase()
            batteryBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_warn))
            batteryIcon.setColorFilter(ContextCompat.getColor(this, R.color.levix_warn))
            batteryHint.text = getString(R.string.battery_restricted_hint)
            batteryButton.visibility = View.VISIBLE
            batteryButton.text = getString(R.string.btn_battery)
        }
    }

    companion object {
        const val EXTRA_OPEN_PANEL = "openPanel"
    }
}
