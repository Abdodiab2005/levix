package net.leviro.levix

import android.content.Intent

object OnboardingGate {
    fun shouldShow(action: String?, launcherCategory: Boolean, openPanel: Boolean,
        completed: Boolean): Boolean =
        action == Intent.ACTION_MAIN && launcherCategory && !openPanel && !completed
}
