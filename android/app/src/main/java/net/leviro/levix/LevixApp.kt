package net.leviro.levix

import android.app.Application

class LevixApp : Application() {
    override fun onCreate() {
        super.onCreate()
        UiPrefs.restore(this)
        HostLog.init(this)
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                HostLog.crash(error)
            } catch (_: Exception) {
                // Logging must never hide the original crash.
            }
            previous?.uncaughtException(thread, error)
        }
        HostLog.event("app created")
    }
}
