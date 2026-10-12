package net.leviro.levix

import android.app.Application
import android.app.Activity
import android.app.Application.ActivityLifecycleCallbacks
import android.os.Bundle

class LevixApp : Application() {
    override fun onCreate() {
        super.onCreate()
        UiPrefs.restore(this)
        HostLog.init(this)
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                CrashReports.captureThrowable(this, error)
            } catch (_: Throwable) {
                // Report persistence must never hide the original crash.
            }
            try {
                HostLog.crash(error)
            } catch (_: Exception) {
                // Logging must never hide the original crash.
            }
            previous?.uncaughtException(thread, error)
        }
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, state: Bundle?) =
                CrashReports.lifecycle(activity.javaClass.simpleName, "created")
            override fun onActivityStarted(activity: Activity) =
                CrashReports.lifecycle(activity.javaClass.simpleName, "started")
            override fun onActivityResumed(activity: Activity) =
                CrashReports.lifecycle(activity.javaClass.simpleName, "resumed")
            override fun onActivityPaused(activity: Activity) =
                CrashReports.lifecycle(activity.javaClass.simpleName, "paused")
            override fun onActivityStopped(activity: Activity) =
                CrashReports.lifecycle(activity.javaClass.simpleName, "stopped")
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) =
                CrashReports.lifecycle(activity.javaClass.simpleName, "destroyed")
        })
        try {
            CrashReports.sweep(CrashReports.directory(this))
            CrashReports.collectHistoricalExits(this)
        } catch (error: Exception) {
            HostLog.event("crash report recovery failed: ${error.javaClass.simpleName}")
        }
        HostLog.event("app created")
    }
}
