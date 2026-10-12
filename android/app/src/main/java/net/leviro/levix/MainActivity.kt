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
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import net.leviro.levix.media.MediaHubActivity

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
        if (savedInstanceState == null && maybeShowOnboarding(intent)) return
        // Edge-to-edge on every Android version, not only the 15+ that force
        // it; the root pads itself from the insets below.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
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

        val isArabic = UiPrefs.language(this) == "ar"
        
        val cardLanguageSwitch = findViewById<View?>(R.id.cardLanguageSwitch)
        val btnLanguageToggleCard = findViewById<TextView?>(R.id.btnLanguageToggleCard)
        btnLanguageToggleCard?.text = if (isArabic) "العربية" else "English"

        val showLanguageDialog = {
            val languages = arrayOf(getString(R.string.lang_arabic), getString(R.string.lang_english))
            val languageTags = arrayOf("ar", "en")
            val isCurrentAr = UiPrefs.language(this) == "ar"
            val currentIndex = if (isCurrentAr) 0 else 1

            com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
                .setTitle(R.string.dialog_choose_language)
                .setSingleChoiceItems(languages, currentIndex) { dialog, which ->
                    dialog.dismiss()
                    if (which != currentIndex) {
                        val targetTag = languageTags[which]
                        UiPrefs.set(this, targetTag, UiPrefs.theme(this), "language")
                    }
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }

        btnLanguage.setOnClickListener { showLanguageDialog() }
        cardLanguageSwitch?.setOnClickListener { showLanguageDialog() }
        btnLanguageToggleCard?.setOnClickListener { showLanguageDialog() }

        val themeButton = findViewById<TextView>(R.id.btnThemeToggleCard)
        themeButton.text = getString(if (UiPrefs.theme(this) == "dark") R.string.theme_dark else R.string.theme_light)
        findViewById<View>(R.id.cardThemeSwitch).setOnClickListener {
            val next = if (UiPrefs.theme(this) == "dark") "light" else "dark"
            UiPrefs.set(this, UiPrefs.language(this), next, "theme")
        }
        findViewById<View>(R.id.cardShowGuide).setOnClickListener {
            OnboardingActivity.showAgain(this)
        }

        heroSubtitleText = findViewById(R.id.heroSubtitleText)
        panelButton = findViewById(R.id.panelButton)
        startButton = findViewById(R.id.startButton)
        stopButton = findViewById(R.id.stopButton)
        statusHint = findViewById(R.id.statusHint)

        cardWhatsApp = findViewById(R.id.cardWhatsApp)
        whatsAppBadge = findViewById(R.id.whatsAppBadge)
        whatsAppDetailText = findViewById(R.id.whatsAppDetailText)
        cardWhatsApp.setOnClickListener { WhatsAppStatusSheet.show(this) }

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
        findViewById<View>(R.id.cardMediaHub).setOnClickListener { startActivity(Intent(this, MediaHubActivity::class.java)) }
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
        if (maybeShowOnboarding(intent)) return
        maybeOpenPanel(intent)
    }

    private fun maybeShowOnboarding(intent: Intent?): Boolean {
        if (!OnboardingGate.shouldShow(intent?.action,
                intent?.hasCategory(Intent.CATEGORY_LAUNCHER) == true,
                intent?.getBooleanExtra(EXTRA_OPEN_PANEL, false) == true,
                OnboardingActivity.completed(this))) return false
        startActivity(Intent(this, OnboardingActivity::class.java))
        finish()
        return true
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
        maybePromptForCrash(snapshot)
    }

    private fun maybePromptForCrash(snapshot: HostState.Snapshot) {
        if (crashPromptShown || !snapshot.running || !snapshot.levixReady ||
            !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) ||
            !CrashReports.hasPending(this)) return
        crashPromptShown = true
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.crash_prompt_title)
            .setMessage(R.string.crash_prompt_body)
            .setPositiveButton(R.string.crash_prompt_review) { _, _ ->
                PanelActivity.open(this, "settings/diagnostics")
            }
            .setNegativeButton(R.string.crash_prompt_later, null)
            .setNeutralButton(R.string.crash_prompt_delete) { _, _ ->
                CrashReports.deleteAll(this)
            }
            .show()
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
        private var crashPromptShown = false
    }
}
