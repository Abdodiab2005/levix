package net.leviro.levix

import android.content.Context

/**
 * Durable host intent. Boot and process-death recovery read this: Start
 * means we should come back; Stop means we must not.
 */
object HostPrefs {
    private const val PREFS = "levix_host"
    private const val KEY_WANTED = "wanted_running"

    fun wantedRunning(context: Context): Boolean {
        return prefs(context).getBoolean(KEY_WANTED, false)
    }

    fun setWantedRunning(context: Context, wanted: Boolean) {
        prefs(context).edit().putBoolean(KEY_WANTED, wanted).apply()
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
