package net.leviro.levix

import android.content.Context
import android.content.Intent

/**
 * When the home tour runs, and the one preference that remembers it ran.
 *
 * The tour itself lives on MainActivity now ([CoachMarkOverlay]); this object
 * only answers "should a launcher visit start it" and stores completion under
 * the key older builds used, so an installed app that already finished the
 * old slide guide is not shown the new one after updating.
 */
object OnboardingGate {
    private const val PREFS = "levix_onboarding"
    private const val KEY_COMPLETED = "onboarding_completed"

    fun shouldShow(action: String?, launcherCategory: Boolean, openPanel: Boolean,
        completed: Boolean): Boolean =
        action == Intent.ACTION_MAIN && launcherCategory && !openPanel && !completed

    /** True once the tour has been finished or skipped on this install. */
    fun completed(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_COMPLETED, false)

    fun markCompleted(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_COMPLETED, true).apply()
    }
}
