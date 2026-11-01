package net.leviro.levix

import android.animation.ValueAnimator
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import net.leviro.levix.media.MediaHubActivity

class MainActivity : AppCompatActivity(), CoachMarkOverlay.Host {
    private val uiHandler = Handler(Looper.getMainLooper())

    // Header preferences share the app theme and locale.
    private lateinit var headerThemeControl: ImageView

    // Adaptive activation card: start circle, progress, next action, separate stop.
    private lateinit var heroSubtitleText: TextView
    private lateinit var primaryAction: View
    private lateinit var primaryActionIcon: ImageView
    private lateinit var primaryActionLabel: TextView
    private lateinit var stopCorner: View
    private lateinit var panelButton: Button
    private lateinit var statusHint: TextView

    // Status Overview Tiles
    private lateinit var cardWhatsApp: View
    private lateinit var whatsAppBadge: TextView
    private lateinit var whatsAppDetailText: TextView

    private lateinit var cardEngine: View
    private lateinit var engineBadge: TextView
    private lateinit var engineDetailText: TextView

    // Battery Guard — the one card that can grow into a warning banner.
    private lateinit var cardBattery: View
    private lateinit var batteryIcon: ImageView
    private lateinit var batteryHint: TextView
    private lateinit var batteryBadge: TextView
    private lateinit var batteryButton: Button

    // Diagnostics & Logs
    private lateinit var cardDiagnostics: View

    private var batteryRestricted: Boolean? = null
    private var requestedAt = 0L
    private var renderedState: HomePresentation.State? = null
    private var unsubscribe: (() -> Unit)? = null
    private val timeout = Runnable { render(HostState.snapshot) }

    // The home tour. Null means it is not on screen; the step it is on is
    // carried in saved state so a rotation or a theme change does not restart
    // the tour from the first stop.
    private var coachMarks: CoachMarkOverlay? = null
    private val coachBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            coachMarks?.goBack()
        }
    }

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            statusHint.visibility = View.GONE
            startHost()
        } else {
            requestedAt = 0L
            render(HostState.snapshot)
            statusHint.text = getString(R.string.notifications_required)
            statusHint.visibility = View.VISIBLE
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge on every Android version, not only the 15+ that force
        // it; the root pads itself from the insets below.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        setContentView(R.layout.activity_main)
        onBackPressedDispatcher.addCallback(this, coachBack)

        val root = findViewById<View>(R.id.rootScrollView)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(insets.left, insets.top, insets.right, insets.bottom)
            windowInsets
        }

        requestedAt = savedInstanceState?.getLong("requestedAt") ?: 0L

        // Bind views

        // Language and appearance live in the header and nowhere else, as
        // icons only: the strip has no room for a label beside the brand.
        // The theme icon flips on tap; the language icon opens the four-item
        // picker below, because a question with four answers does not fit a
        // single tap.
        headerThemeControl = findViewById(R.id.headerThemeControl)
        paintThemeIcon()
        findViewById<View>(R.id.headerLanguageControl).setOnClickListener {
            showLanguagePicker()
        }
        headerThemeControl.setOnClickListener {
            val next = if (UiPrefs.theme(this) == "dark") "light" else "dark"
            UiPrefs.set(this, UiPrefs.language(this), next, "theme")
        }
        findViewById<View>(R.id.cardShowGuide).setOnClickListener {
            startCoachMarks(0)
        }

        heroSubtitleText = findViewById(R.id.heroSubtitleText)
        primaryAction = findViewById(R.id.btnPrimaryAction)
        primaryActionIcon = findViewById(R.id.primaryActionIcon)
        primaryActionLabel = findViewById(R.id.primaryActionLabel)
        stopCorner = findViewById(R.id.btnStopCorner)
        panelButton = findViewById(R.id.panelButton)
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

        cardDiagnostics = findViewById(R.id.cardDiagnostics)

        ViewCompat.setAccessibilityDelegate(primaryAction, object : AccessibilityDelegateCompat() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.className = Button::class.java.name
            }
        })
        primaryAction.setOnClickListener { performPrimaryAction() }
        stopCorner.setOnClickListener {
            stopCorner.isEnabled = false
            LevixHostService.stop(this)
        }
        panelButton.setOnClickListener { performPrimaryAction() }
        findViewById<View>(R.id.cardMediaHub).setOnClickListener {
            startActivity(Intent(this, MediaHubActivity::class.java))
        }
        batteryButton.setOnClickListener { HostBattery.requestUnrestricted(this) }
        cardDiagnostics.setOnClickListener { LogsActionsSheet.show(this) }

        render(HostState.snapshot)
        maybeOpenPanel(intent)
        restoreCoachMarks(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (maybeShowOnboarding(intent)) return
        maybeOpenPanel(intent)
    }

    /**
     * First launch opens the tour over the real home screen. A rotation or a
     * theme change restores the stop it was on instead of starting over.
     */
    private fun restoreCoachMarks(savedState: Bundle?) {
        if (savedState != null) {
            if (savedState.getBoolean(STATE_COACH_ACTIVE, false)) {
                startCoachMarks(savedState.getInt(STATE_COACH_TARGET, 0))
            }
            return
        }
        maybeShowOnboarding(intent)
    }

    private fun maybeShowOnboarding(intent: Intent?): Boolean {
        if (!OnboardingGate.shouldShow(intent?.action,
                intent?.hasCategory(Intent.CATEGORY_LAUNCHER) == true,
                intent?.getBooleanExtra(EXTRA_OPEN_PANEL, false) == true,
                OnboardingGate.completed(this))) return false
        startCoachMarks(0)
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

    /**
     * The appearance control shows the theme that is on, not the one it would
     * switch to: a sun while the phone is in light, a moon while it is dark.
     */
    private fun paintThemeIcon() {
        headerThemeControl.setImageResource(
            if (UiPrefs.theme(this) == "dark") R.drawable.ic_moon else R.drawable.ic_sun,
        )
    }

    /**
     * One tap on the header language icon: a single-choice dialog over the
     * four shipped languages (UiPrefs.LANGUAGES). Every entry shows its own
     * native name, whatever language the app runs in.
     */
    private fun showLanguagePicker() {
        val names = UiPrefs.LANGUAGES.map { code ->
            when (code) {
                "ar" -> getString(R.string.language_name_ar)
                "en" -> getString(R.string.language_name_en)
                "pt-BR" -> getString(R.string.language_name_pt_br)
                else -> getString(R.string.language_name_es_419)
            }
        }.toTypedArray()
        val checked = UiPrefs.LANGUAGES.indexOf(UiPrefs.language(this)).coerceAtLeast(0)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.language_picker_title)
            .setSingleChoiceItems(names, checked) { dialog, which ->
                dialog.dismiss()
                val language = UiPrefs.LANGUAGES[which]
                if (language != UiPrefs.language(this)) {
                    UiPrefs.set(this, language, UiPrefs.theme(this), "language")
                }
            }
            .show()
    }

    private fun openPanel() {
        val url = HostState.snapshot.panelUrl ?: "http://127.0.0.1:3001/"
        startActivity(
            Intent(this, PanelActivity::class.java)
                .putExtra(PanelActivity.EXTRA_URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
    }

    // ---- Home tour ---------------------------------------------------------

    /**
     * Puts the coach-mark overlay on top of the content view. Everything it
     * describes is the real control, so it is added after the screen is bound
     * and laid out; [target] is the stop to resume on, 0 to start at the top.
     */
    private fun startCoachMarks(target: Int) {
        if (isFinishing || isDestroyed || coachMarks != null) return
        val content = findViewById<ViewGroup>(android.R.id.content) ?: return
        val overlay = CoachMarkOverlay(this)
        coachMarks = overlay
        coachBack.isEnabled = true
        // The tour is modal: assistive technology should read the card, not the
        // page sitting under the scrim.
        ViewCompat.setImportantForAccessibility(
            findViewById(R.id.rootScrollView),
            View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS,
        )
        content.addView(
            overlay,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        overlay.start(this, target)
    }

    override fun coachTarget(targetId: Int): View? = findViewById<View>(targetId)

    /** Scrolls the home screen so the ring sits just below the status bar. */
    override fun coachReveal(target: View) {
        val scroll = findViewById<ScrollView>(R.id.rootScrollView)
        if (target !== scroll && !isDescendantOf(target, scroll)) return
        // Work from window positions rather than the scroll offset alone, so a
        // target inside nested padding still lands where it is measured.
        val targetLocation = IntArray(2)
        target.getLocationInWindow(targetLocation)
        val scrollLocation = IntArray(2)
        scroll.getLocationInWindow(scrollLocation)
        val contentTop = targetLocation[1] - scrollLocation[1] + scroll.scrollY
        val breathing = (16 * resources.displayMetrics.density).toInt()
        val max = ((scroll.getChildAt(0)?.height ?: 0) +
            scroll.paddingTop + scroll.paddingBottom - scroll.height).coerceAtLeast(0)
        scroll.scrollTo(0, (contentTop - scroll.paddingTop - breathing).coerceIn(0, max))
    }

    override fun coachShift(dy: Int) {
        findViewById<ScrollView>(R.id.rootScrollView).scrollBy(0, -dy)
    }

    override fun coachFinished(completed: Boolean) {
        val overlay = coachMarks ?: return
        coachMarks = null
        coachBack.isEnabled = false
        (overlay.parent as? ViewGroup)?.removeView(overlay)
        ViewCompat.setImportantForAccessibility(
            findViewById(R.id.rootScrollView),
            View.IMPORTANT_FOR_ACCESSIBILITY_AUTO,
        )
        if (completed) OnboardingGate.markCompleted(this)
    }

    private fun isDescendantOf(target: View, container: View): Boolean {
        var parent = target.parent
        while (parent != null) {
            if (parent === container) return true
            parent = (parent as? View)?.parent
        }
        return false
    }

    override fun onResume() {
        super.onResume()
        // render() also re-locates an active coach mark, because the host may
        // have changed which controls are on screen while it was paused.
        render(HostState.snapshot)
    }

    override fun onStart() {
        super.onStart()
        unsubscribe = HostState.listen {
            uiHandler.post {
                if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) render(HostState.snapshot)
            }
        }
    }

    override fun onStop() {
        super.onStop()
        unsubscribe?.invoke()
        unsubscribe = null
        uiHandler.removeCallbacks(timeout)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putLong("requestedAt", requestedAt)
        outState.putBoolean(STATE_COACH_ACTIVE, coachMarks != null)
        outState.putInt(STATE_COACH_TARGET, coachMarks?.currentTarget() ?: 0)
        super.onSaveInstanceState(outState)
    }

    private fun performPrimaryAction() {
        when (HomePresentation.from(HostState.snapshot, System.currentTimeMillis(), requestedAt).action) {
            HomePresentation.Action.START -> requestStart()
            HomePresentation.Action.CONNECTION -> PanelActivity.open(this, "connection")
            HomePresentation.Action.PANEL -> openPanel()
            HomePresentation.Action.DIAGNOSTICS -> LogsActionsSheet.show(this)
            HomePresentation.Action.NONE -> Unit
        }
    }

    private fun startHost() {
        try {
            LevixHostService.start(this)
        } catch (error: RuntimeException) {
            requestedAt = 0L
            render(HostState.snapshot)
            statusHint.setText(R.string.home_start_rejected)
            statusHint.visibility = View.VISIBLE
        }
    }

    private fun requestStart() {
        requestedAt = System.currentTimeMillis()
        render(HostState.snapshot)
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
        startHost()
    }

    private fun render(snapshot: HostState.Snapshot) {
        if (snapshot.running) requestedAt = 0L
        renderHome(snapshot)

        // 3. WhatsApp Tile
        renderWhatsAppTile(snapshot)

        // 4. Bot Engine Tile
        renderEngineTile(snapshot)

        // 5. Battery Guard
        renderBatteryCard()
        maybePromptForCrash(snapshot)
        coachMarks?.refresh()
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

    private fun renderHome(snapshot: HostState.Snapshot) {
        val now = System.currentTimeMillis()
        val home = HomePresentation.from(snapshot, now, requestedAt)
        val stopped = home.action == HomePresentation.Action.START
        val good = home.state == HomePresentation.State.READY
        val bad = home.state in listOf(HomePresentation.State.FAILED, HomePresentation.State.EXPIRED)
        val changed = renderedState != home.state
        renderedState = home.state
        val color = ContextCompat.getColor(this, when {
            good -> R.color.levix_ok
            bad -> R.color.levix_danger
            else -> R.color.levix_cyan
        })
        // The hero is the single summary. Detailed engine/session facts stay in their tiles.
        findViewById<TextView>(R.id.homeTitle).apply {
            setText(home.title)
            setTextColor(color)
            if (changed && isLaidOut && ValueAnimator.areAnimatorsEnabled()) {
                alpha = 0.5f
                animate().alpha(1f).setDuration(180L).start()
            }
        }
        heroSubtitleText.setText(home.body)
        findViewById<TextView>(R.id.activationSteps).apply {
            visibility = if (good) View.GONE else View.VISIBLE
            text = getString(when (home.step) {
                1 -> R.string.home_step_start
                else -> R.string.home_step_connect
            })
        }
        findViewById<View>(R.id.startCircleContainer).visibility = if (stopped) View.VISIBLE else View.GONE
        primaryAction.isEnabled = stopped
        val density = resources.displayMetrics.density
        val available = resources.displayMetrics.widthPixels - (80 * density).toInt()
        val diameter = ((192 * resources.configuration.fontScale.coerceIn(1f, 1.4f)) * density).toInt().coerceAtMost(available)
        if (primaryAction.layoutParams.width != diameter) {
            primaryAction.layoutParams = primaryAction.layoutParams.apply { width = diameter; height = diameter }
        }
        primaryAction.contentDescription = getString(R.string.btn_start_host)
        primaryActionIcon.setColorFilter(ContextCompat.getColor(this, R.color.levix_on_gradient))
        primaryActionLabel.setText(R.string.btn_start_host)
        findViewById<View>(R.id.homeProgress).visibility = if (home.busy) View.VISIBLE else View.GONE
        panelButton.visibility = if (stopped) View.GONE else View.VISIBLE
        panelButton.setText(home.actionLabel)
        panelButton.isEnabled = home.action != HomePresentation.Action.NONE
        stopCorner.visibility = if (snapshot.running) View.VISIBLE else View.GONE
        stopCorner.isEnabled = snapshot.running
        // A one-shot deadline replaces the unconditional one-second redraw loop.
        uiHandler.removeCallbacks(timeout)
        if (home.busy) {
            val since = if (!snapshot.running) requestedAt else if (home.step == 1) snapshot.startedAtMs else snapshot.whatsAppSinceMs
            uiHandler.postDelayed(timeout, (since + HomePresentation.WAIT_MS - now).coerceAtLeast(1L))
        }
    }

    private fun renderWhatsAppTile(snapshot: HostState.Snapshot) {
        val home = HomePresentation.from(snapshot, System.currentTimeMillis(), requestedAt)
        val label = when {
            !snapshot.running -> R.string.status_offline
            home.step == 1 -> R.string.status_unknown_short
            home.state == HomePresentation.State.READY -> R.string.status_connected
            home.state == HomePresentation.State.PAIRING -> R.string.status_pairing_short
            home.state == HomePresentation.State.EXPIRED -> R.string.status_expired_short
            home.state == HomePresentation.State.FAILED -> R.string.status_failed
            home.state == HomePresentation.State.RECONNECTING -> R.string.status_reconnecting
            home.state == HomePresentation.State.PAUSED -> R.string.status_paused
            home.busy -> R.string.status_starting
            else -> R.string.status_unknown_short
        }
        whatsAppBadge.setText(label)
        whatsAppBadge.setTextColor(ContextCompat.getColor(this,
            if (home.state == HomePresentation.State.READY) R.color.levix_ok else R.color.levix_text_muted))
        whatsAppDetailText.setText(if (!snapshot.running || home.step == 1) R.string.card_whatsapp_desc_offline
            else if (home.state == HomePresentation.State.READY) R.string.card_whatsapp_desc_connected_short
            else R.string.home_connection_details)
    }

    private fun renderEngineTile(snapshot: HostState.Snapshot) {
        if (!snapshot.running) {
            engineBadge.text = getString(R.string.status_stopped).uppercase()
            engineBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_text_muted))
            engineDetailText.text = getString(R.string.card_engine_desc_stopped_short)
            return
        }

        if (snapshot.levixReady && snapshot.nodeAlive && snapshot.nodeError == null) {
            engineBadge.text = getString(R.string.status_operational).uppercase()
            engineBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_ok))
            engineDetailText.text = getString(R.string.card_engine_desc_running_short)
        } else if (snapshot.nodeError != null) {
            engineBadge.setText(R.string.status_failed)
            engineBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_danger))
            engineDetailText.setText(R.string.home_engine_error_body)
        } else {
            val home = HomePresentation.from(snapshot, System.currentTimeMillis(), requestedAt)
            engineBadge.setText(if (home.busy) R.string.status_starting else R.string.status_unknown_short)
            engineBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_cyan))
            engineDetailText.setText(if (home.busy) R.string.card_engine_desc_starting_short else R.string.home_start_timeout)
        }
    }

    /** A restriction gets a fix action; an exemption stays a quiet health fact. */
    private fun renderBatteryCard() {
        val restricted = !HostBattery.isUnrestricted(this)
        if (batteryRestricted == restricted) return
        batteryRestricted = restricted

        if (restricted) {
            cardBattery.setBackgroundResource(R.drawable.bg_banner_warn)
            batteryBadge.text = getString(R.string.status_restricted).uppercase()
            batteryBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_warn))
            batteryIcon.setColorFilter(ContextCompat.getColor(this, R.color.levix_warn))
            batteryHint.text = getString(R.string.battery_hint)
            batteryButton.visibility = View.VISIBLE
            batteryButton.text = getString(R.string.btn_battery)
        } else {
            cardBattery.setBackgroundResource(R.drawable.bg_card_panel)
            batteryBadge.text = getString(R.string.status_protected).uppercase()
            batteryBadge.setTextColor(ContextCompat.getColor(this, R.color.levix_ok))
            batteryIcon.setColorFilter(ContextCompat.getColor(this, R.color.levix_ok))
            batteryHint.text = getString(R.string.battery_ok_short)
            batteryButton.visibility = View.GONE
        }
    }

    companion object {
        const val EXTRA_OPEN_PANEL = "openPanel"

        private const val STATE_COACH_ACTIVE = "coachActive"
        private const val STATE_COACH_TARGET = "coachTarget"

        private var crashPromptShown = false
    }
}
