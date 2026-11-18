package net.leviro.levix

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallState
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import com.google.android.play.core.review.ReviewInfo
import com.google.android.play.core.review.ReviewManager
import com.google.android.play.core.review.ReviewManagerFactory
import org.json.JSONObject

/**
 * Activity-owned Play update/review host.
 *
 * No Play client exists until the app was installed by Google Play and the
 * operator picks an action: [AppUpdateManager] and [ReviewManager] are created
 * lazily inside a submitted request, never in the constructor or from a plain
 * panel load. A GitHub/self-hosted install never touches the Play libraries at
 * all.
 *
 * All mutable state is confined to the main thread. Every request answers
 * through the activity's deliver callback (`window.__levixHostDone`) and every
 * callback re-checks the call it belongs to, so a late task from a destroyed
 * activity cannot write into a rebuilt panel.
 */
class PlayExperience(
    private val activity: Activity,
    private val onUpdateState: () -> Unit,
    private val deliver: (String, JSONObject) -> Unit,
    private val launcher: ActivityResultLauncher<IntentSenderRequest>?,
) {
    private val main = Handler(Looper.getMainLooper())
    private var destroyed = false

    private var updateManager: AppUpdateManager? = null
    private var reviewManager: ReviewManager? = null
    private var listener: InstallStateUpdatedListener? = null
    private var listenerRegistered = false
    private var updateCall: Call? = null
    private var reviewCall: Call? = null

    /** A flexible flow has been started or a downloaded update was observed. */
    private var flowBegan = installedByPlay(activity) && prefs(activity).getBoolean(KEY_UPDATE_STARTED, false)
    private var downloaded = false

    /**
     * Review is offered only after this activity's own successful check said
     * there is nothing to install. The Rate action in the panel opens the
     * listing and never calls the Review API.
     */
    @Volatile
    private var lastCheckClean = false

    private class Call(val id: String) {
        var timeout: Runnable? = null
        var awaitingFlow = false
    }

    fun checkUpdate(callId: String): String {
        // A check in progress never leaves an earlier clean result standing.
        lastCheckClean = false
        return submitUpdate(callId) { call, manager ->
            manager.appUpdateInfo.addOnCompleteListener { task ->
                main.post {
                    if (!ownsUpdate(call)) return@post
                    if (!task.isSuccessful) {
                        finishUpdate(call, unavailable())
                        return@post
                    }
                    val info = runCatching { task.result }.getOrNull()
                    if (info == null) {
                        finishUpdate(call, unavailable())
                        return@post
                    }
                    noteInstallState(info)
                    // A download already in flight should keep reporting
                    // progress to the page, even if this activity did not
                    // start the flow.
                    if (info.installStatus() == InstallStatus.DOWNLOADING ||
                        info.installStatus() == InstallStatus.PENDING ||
                        info.installStatus() == InstallStatus.DOWNLOADED
                    ) {
                        ensureListener(manager)
                    }
                    lastCheckClean = updateStatus(info.updateAvailability(), info.installStatus()) ==
                        STATUS_UP_TO_DATE
                    finishUpdate(call, statusJson(info))
                }
            }
        }
    }

    fun startUpdate(callId: String): String = submitUpdate(callId) { call, manager ->
        manager.appUpdateInfo.addOnCompleteListener { task ->
            main.post {
                if (!ownsUpdate(call)) return@post
                if (!task.isSuccessful) {
                    finishUpdate(call, unavailable())
                    return@post
                }
                val info = runCatching { task.result }.getOrNull()
                if (info == null) {
                    finishUpdate(call, unavailable())
                    return@post
                }
                noteInstallState(info)
                // Already downloaded by an earlier flexible flow: there is
                // nothing to start, the panel may complete it instead.
                if (info.installStatus() == InstallStatus.DOWNLOADED) {
                    finishUpdate(call, statusJson(info))
                    return@post
                }
                if (!info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)) {
                    finishUpdate(call, unavailable())
                    return@post
                }
                val target = launcher
                if (target == null) {
                    finishUpdate(call, unavailable())
                    return@post
                }
                try {
                    ensureListener(manager)
                    val accepted = manager.startUpdateFlowForResult(
                        info,
                        target,
                        AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build(),
                    )
                    if (!accepted) {
                        finishUpdate(call, unavailable())
                        return@post
                    }
                    flowBegan = true
                    rememberUpdateFlow(true)
                    // The operator may spend a while in Play's UI, so the
                    // request timeout becomes a long, bounded flow timeout.
                    // Activity result, destroy() or that bound closes it.
                    call.awaitingFlow = true
                    call.timeout?.let { main.removeCallbacks(it) }
                    call.timeout = Runnable { finishUpdate(call, failure(CODE_TIMEOUT)) }
                    main.postDelayed(call.timeout!!, FLOW_TIMEOUT_MS)
                } catch (_: Exception) {
                    finishUpdate(call, unavailable())
                }
            }
        }
    }

    fun completeUpdate(callId: String): String = submitUpdate(callId) { call, manager ->
        manager.appUpdateInfo.addOnCompleteListener { task ->
            main.post {
                if (!ownsUpdate(call)) return@post
                if (!task.isSuccessful) {
                    finishUpdate(call, unavailable())
                    return@post
                }
                val info = runCatching { task.result }.getOrNull()
                if (info == null) {
                    finishUpdate(call, unavailable())
                    return@post
                }
                noteInstallState(info)
                // Completing requires a download the operator actually has.
                if (info.installStatus() != InstallStatus.DOWNLOADED) {
                    finishUpdate(call, unavailable())
                    return@post
                }
                try {
                    manager.completeUpdate().addOnCompleteListener { completion ->
                        main.post {
                            if (!ownsUpdate(call)) return@post
                            finishUpdate(call, if (completion.isSuccessful)
                                JSONObject().put("ok", true).put("status", STATUS_STARTED)
                            else unavailable())
                        }
                    }
                } catch (_: Exception) {
                    finishUpdate(call, unavailable())
                    return@post
                }
            }
        }
    }

    /**
     * Shows Play's own review card when the operator opted in, the activity is
     * in front, at least [REVIEW_INTERVAL_MS] passed since the last attempt,
     * and this activity just found no update pending. Play may still suppress
     * the card. The result is never surfaced as a rating, and no feature reads
     * it.
     */
    fun maybeReview(callId: String): String {
        if (!PanelFiles.validCallId(callId)) return failure(CODE_INVALID_INPUT).toString()
        if (!installedByPlay(activity)) return unavailable().toString()
        if (destroyed) return unavailable().toString()
        main.post {
            if (destroyed) return@post
            if (reviewCall != null) {
                deliver(callId, failure(CODE_BUSY))
                return@post
            }
            val now = System.currentTimeMillis()
            val denial = reviewDenialCode(
                installedByPlay = true,
                enabled = reviewPromptsEnabled(activity),
                foreground = isForeground(),
                checkedClean = lastCheckClean,
                lastRequestMs = reviewRequestedAt(activity),
                nowMs = now,
            )
            if (denial != null) {
                deliver(callId, failure(denial))
                return@post
            }
            // Recorded before the API request, whatever Play answers or shows,
            // so a suppression cannot cause a request on the next message.
            setReviewRequestedAt(activity, now)
            val call = Call(callId)
            reviewCall = call
            call.timeout = Runnable { finishReview(call, failure(CODE_TIMEOUT)) }
            main.postDelayed(call.timeout!!, REQUEST_TIMEOUT_MS)
            val manager = reviews()
            try {
                manager.requestReviewFlow().addOnCompleteListener { task ->
                    main.post {
                        if (!ownsReview(call)) return@post
                        val info: ReviewInfo? =
                            if (task.isSuccessful) runCatching { task.result }.getOrNull() else null
                        if (info == null) {
                            finishReview(call, failure(CODE_UNAVAILABLE))
                            return@post
                        }
                        // Consent and foreground can change while Play answers.
                        if (!reviewPromptsEnabled(activity) || !isForeground() || !lastCheckClean) {
                            finishReview(call, failure(CODE_DISABLED))
                            return@post
                        }
                        try {
                            manager.launchReviewFlow(activity, info).addOnCompleteListener {
                                main.post {
                                    if (ownsReview(call)) finishReview(call, JSONObject().put("ok", true))
                                }
                            }
                        } catch (_: Exception) {
                            finishReview(call, failure(CODE_UNAVAILABLE))
                        }
                    }
                }
            } catch (_: Exception) {
                finishReview(call, failure(CODE_UNAVAILABLE))
            }
        }
        return pending()
    }

    /** Called from the panel activity's StartIntentSenderForResult contract. */
    fun onUpdateFlowResult(resultCode: Int) {
        main.post {
            if (destroyed) return@post
            val call = updateCall ?: return@post
            if (!call.awaitingFlow) return@post
            call.awaitingFlow = false
            when (val outcome = flowOutcome(resultCode)) {
                FLOW_FAILED -> {
                    flowBegan = false
                    rememberUpdateFlow(false)
                    finishUpdate(call, unavailable())
                }
                else -> {
                    if (outcome == STATUS_CANCELLED) {
                        flowBegan = false
                        rememberUpdateFlow(false)
                    }
                    finishUpdate(call, JSONObject().put("ok", true).put("status", outcome))
                }
            }
        }
    }

    /**
     * Resume asks Play for the current state only when an update flow already
     * began in this or an earlier activity (or a download was observed). It never
     * starts a check, a prompt or a download by itself.
     */
    fun onResume() {
        main.post {
            if (destroyed) return@post
            if (!flowBegan && !downloaded) return@post
            if (!installedByPlay(activity)) return@post
            try {
                appUpdates().appUpdateInfo.addOnCompleteListener { task ->
                    main.post {
                        if (destroyed || !task.isSuccessful) return@post
                        val info = runCatching { task.result }.getOrNull() ?: return@post
                        noteInstallState(info)
                        if (flowBegan) ensureListener(appUpdates())
                        onUpdateState()
                    }
                }
            } catch (_: Exception) {
                // A missing or broken Play store is not an error the panel
                // needs to see on resume.
            }
        }
    }

    fun destroy() {
        if (destroyed) return
        updateCall?.let { finishUpdate(it, unavailable()) }
        reviewCall?.let { finishReview(it, failure(CODE_UNAVAILABLE)) }
        destroyed = true
        val registered = listener
        val manager = updateManager
        if (listenerRegistered && registered != null && manager != null) {
            runCatching { manager.unregisterListener(registered) }
        }
        listenerRegistered = false
        listener = null
        updateManager = null
        reviewManager = null
    }

    private fun submitUpdate(callId: String, action: (Call, AppUpdateManager) -> Unit): String {
        if (!PanelFiles.validCallId(callId)) return failure(CODE_INVALID_INPUT).toString()
        if (!installedByPlay(activity)) return unavailable().toString()
        if (destroyed) return unavailable().toString()
        main.post {
            if (destroyed) return@post
            if (updateCall != null) {
                deliver(callId, failure(CODE_BUSY))
                return@post
            }
            val call = Call(callId)
            updateCall = call
            call.timeout = Runnable { finishUpdate(call, failure(CODE_TIMEOUT)) }
            main.postDelayed(call.timeout!!, REQUEST_TIMEOUT_MS)
            try {
                action(call, appUpdates())
            } catch (_: Exception) {
                finishUpdate(call, unavailable())
            }
        }
        return pending()
    }

    private fun appUpdates(): AppUpdateManager =
        updateManager ?: AppUpdateManagerFactory.create(activity).also { updateManager = it }

    private fun reviews(): ReviewManager =
        reviewManager ?: ReviewManagerFactory.create(activity).also { reviewManager = it }

    private fun ownsUpdate(call: Call): Boolean = !destroyed && updateCall === call

    private fun ownsReview(call: Call): Boolean = !destroyed && reviewCall === call

    private fun finishUpdate(call: Call, result: JSONObject) {
        if (destroyed || updateCall !== call) return
        call.timeout?.let { main.removeCallbacks(it) }
        updateCall = null
        deliver(call.id, result)
    }

    private fun finishReview(call: Call, result: JSONObject) {
        if (destroyed || reviewCall !== call) return
        call.timeout?.let { main.removeCallbacks(it) }
        reviewCall = null
        deliver(call.id, result)
    }

    private fun ensureListener(manager: AppUpdateManager) {
        if (listenerRegistered) return
        val candidate = object : InstallStateUpdatedListener {
            override fun onStateUpdate(state: InstallState) {
                main.post {
                    if (destroyed) return@post
                    val status = state.installStatus()
                    if (status == InstallStatus.DOWNLOADING || status == InstallStatus.PENDING) {
                        flowBegan = true
                    }
                    // Only the actionable transition reaches the page. Progress
                    // ticks are not a reason to make the page query Play again.
                    if (status == InstallStatus.DOWNLOADED) {
                        downloaded = true
                        flowBegan = true
                        onUpdateState()
                    }
                }
            }
        }
        if (runCatching { manager.registerListener(candidate) }.isSuccess) {
            listener = candidate
            listenerRegistered = true
        }
    }

    private fun noteInstallState(info: AppUpdateInfo) {
        val status = info.installStatus()
        if (status == InstallStatus.DOWNLOADED) {
            downloaded = true
            flowBegan = true
        }
        if (status == InstallStatus.DOWNLOADING || status == InstallStatus.PENDING) flowBegan = true
        if ((info.updateAvailability() == UpdateAvailability.UPDATE_NOT_AVAILABLE &&
                status != InstallStatus.DOWNLOADED && status != InstallStatus.DOWNLOADING &&
                status != InstallStatus.PENDING) ||
            status == InstallStatus.CANCELED || status == InstallStatus.FAILED) {
            downloaded = false
            flowBegan = false
        }
        rememberUpdateFlow(flowBegan)
    }

    private fun rememberUpdateFlow(active: Boolean) {
        prefs(activity).edit().putBoolean(KEY_UPDATE_STARTED, active).apply()
    }

    private fun statusJson(info: AppUpdateInfo): JSONObject {
        val out = JSONObject()
            .put("ok", true)
            .put("status", updateStatus(info.updateAvailability(), info.installStatus()))
        val version = info.availableVersionCode()
        if (version > 0) out.put("versionCode", version)
        return out
    }

    private fun isForeground(): Boolean {
        if (activity.isFinishing || activity.isDestroyed) return false
        val lifecycle = (activity as? LifecycleOwner)?.lifecycle
            ?: return activity.hasWindowFocus()
        return lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
    }

    companion object {
        const val CHANNEL_PLAY = "play"
        const val CHANNEL_GITHUB = "github"

        const val STATUS_AVAILABLE = "available"
        const val STATUS_UP_TO_DATE = "up_to_date"
        const val STATUS_DOWNLOADING = "downloading"
        const val STATUS_DOWNLOADED = "downloaded"
        const val STATUS_STARTED = "started"
        const val STATUS_CANCELLED = "cancelled"
        const val STATUS_UNAVAILABLE = "unavailable"

        const val CODE_UNAVAILABLE = "UNAVAILABLE"
        const val CODE_INVALID_INPUT = "INVALID_INPUT"
        const val CODE_BUSY = "BUSY"
        const val CODE_TIMEOUT = "SERVICE_TIMEOUT"
        const val CODE_DISABLED = "DISABLED"
        const val CODE_FOREGROUND = "FOREGROUND"
        const val CODE_COOLDOWN = "COOLDOWN"
        const val CODE_CHECK_REQUIRED = "CHECK_REQUIRED"

        /** Review prompts stay off until the operator opts in locally. */
        const val REVIEW_PROMPTS_DEFAULT = false

        /** Conservative local interval; Play still decides whether UI appears. */
        const val REVIEW_INTERVAL_MS = 120L * 24 * 60 * 60 * 1000

        // Activity.RESULT_OK and Activity.RESULT_CANCELED. Duplicated as plain
        // ints so the flow policy is unit-testable without an Activity.
        const val FLOW_RESULT_OK = -1
        const val FLOW_RESULT_CANCELLED = 0
        const val FLOW_FAILED = "failed"

        private const val REQUEST_TIMEOUT_MS = 30_000L
        private const val FLOW_TIMEOUT_MS = 10 * 60 * 1000L
        private const val PLAY_INSTALLER = "com.android.vending"
        private const val PREFS = "levix_play_experience"
        private const val KEY_REVIEW_PROMPTS = "review_prompts_enabled"
        private const val KEY_REVIEW_REQUESTED_AT = "review_requested_at"
        private const val KEY_UPDATE_STARTED = "update_started"

        fun isPlayInstaller(installer: String?): Boolean = installer == PLAY_INSTALLER

        fun channelForInstaller(installer: String?): String =
            if (isPlayInstaller(installer)) CHANNEL_PLAY else CHANNEL_GITHUB

        fun installChannel(context: Context): String = channelForInstaller(installerPackage(context))

        /** API 30+ reads the install source; API 29 uses the legacy getter. */
        @Suppress("DEPRECATION")
        fun installerPackage(context: Context): String? = try {
            val manager = context.packageManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                manager.getInstallSourceInfo(context.packageName).installingPackageName
            } else {
                manager.getInstallerPackageName(context.packageName)
            }
        } catch (_: Exception) {
            null
        }

        fun installedByPlay(context: Context): Boolean = isPlayInstaller(installerPackage(context))

        fun hasPendingUpdate(context: Context): Boolean =
            installedByPlay(context) && prefs(context).getBoolean(KEY_UPDATE_STARTED, false)

        fun reviewPromptsEnabled(context: Context): Boolean =
            prefs(context).getBoolean(KEY_REVIEW_PROMPTS, REVIEW_PROMPTS_DEFAULT)

        /** True only when the stored value actually changed. */
        fun setReviewPromptsEnabled(context: Context, enabled: Boolean): Boolean {
            val prefs = prefs(context)
            if (prefs.getBoolean(KEY_REVIEW_PROMPTS, REVIEW_PROMPTS_DEFAULT) == enabled) return false
            prefs.edit().putBoolean(KEY_REVIEW_PROMPTS, enabled).apply()
            return true
        }

        fun reviewRequestedAt(context: Context): Long =
            prefs(context).getLong(KEY_REVIEW_REQUESTED_AT, 0L)

        private fun setReviewRequestedAt(context: Context, at: Long) {
            prefs(context).edit().putLong(KEY_REVIEW_REQUESTED_AT, at).apply()
        }

        private fun prefs(context: Context): SharedPreferences =
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        fun reviewDue(lastRequestMs: Long, nowMs: Long): Boolean =
            lastRequestMs <= 0L || nowMs - lastRequestMs >= REVIEW_INTERVAL_MS

        /**
         * Null means the request may run. Codes are stable and local; nothing
         * here reads a rating, a dismissal or Play's UI outcome.
         */
        fun reviewDenialCode(
            installedByPlay: Boolean,
            enabled: Boolean,
            foreground: Boolean,
            checkedClean: Boolean,
            lastRequestMs: Long,
            nowMs: Long,
        ): String? = when {
            !installedByPlay -> CODE_UNAVAILABLE
            !enabled -> CODE_DISABLED
            !foreground -> CODE_FOREGROUND
            !checkedClean -> CODE_CHECK_REQUIRED
            !reviewDue(lastRequestMs, nowMs) -> CODE_COOLDOWN
            else -> null
        }

        fun flowOutcome(resultCode: Int): String = when (resultCode) {
            FLOW_RESULT_OK -> STATUS_STARTED
            FLOW_RESULT_CANCELLED -> STATUS_CANCELLED
            else -> FLOW_FAILED
        }

        /**
         * Pure mapping behind both the query and the install listener. Unknown
         * or failed Play states stay "unavailable" rather than inventing an
         * update.
         */
        fun updateStatus(availability: Int, installStatus: Int): String = when {
            installStatus == InstallStatus.DOWNLOADED -> STATUS_DOWNLOADED
            installStatus == InstallStatus.DOWNLOADING ||
                installStatus == InstallStatus.PENDING -> STATUS_DOWNLOADING
            availability == UpdateAvailability.UPDATE_AVAILABLE -> STATUS_AVAILABLE
            availability == UpdateAvailability.UPDATE_NOT_AVAILABLE -> STATUS_UP_TO_DATE
            availability == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS ->
                STATUS_DOWNLOADING
            else -> STATUS_UNAVAILABLE
        }

        fun failure(code: String): JSONObject =
            JSONObject().put("ok", false).put("code", code)

        fun unavailable(): JSONObject =
            failure(CODE_UNAVAILABLE).put("status", STATUS_UNAVAILABLE)

        /** Immediate answer for an asynchronous bridge call. */
        fun pending(): String = JSONObject().put("ok", true).toString()
    }
}
