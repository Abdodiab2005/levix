package net.leviro.levix

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import org.json.JSONObject

internal object UiPrefs {
    private const val STORE = "ui_prefs"
    private const val LANGUAGE_FIELD = "language"
    private const val THEME = "theme"

    fun validLanguage(value: String) = value == "ar" || value == "en"
    fun validTheme(value: String) = value == "light" || value == "dark"

    fun fromLocale(language: String?): String =
        if (language?.startsWith("ar", ignoreCase = true) == true) "ar" else "en"

    fun language(context: Context): String {
        val locales = AppCompatDelegate.getApplicationLocales()
        if (!locales.isEmpty) return fromLocale(locales[0]?.language)
        return fromLocale(context.resources.configuration.locales[0]?.language)
    }

    fun theme(context: Context): String {
        val saved = context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getString(THEME, null)
        if (saved != null && validTheme(saved)) return saved
        val night = Resources.getSystem().configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return if (night == Configuration.UI_MODE_NIGHT_YES) "dark" else "light"
    }

    fun json(context: Context): String = JSONObject()
        .put("language", language(context))
        .put("theme", theme(context))
        .toString()

    fun restore(context: Context) {
        val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        AppCompatDelegate.setDefaultNightMode(
            when (prefs.getString(THEME, null)) {
                "light" -> AppCompatDelegate.MODE_NIGHT_NO
                "dark" -> AppCompatDelegate.MODE_NIGHT_YES
                else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            },
        )
    }

    fun set(context: Context, language: String, theme: String, field: String): Boolean {
        if (!validLanguage(language) || !validTheme(theme) ||
            (field != LANGUAGE_FIELD && field != THEME)) return false
        if (field == LANGUAGE_FIELD) {
            val locales = AppCompatDelegate.getApplicationLocales()
            if (!locales.isEmpty && fromLocale(locales[0]?.language) == language) return false
            Handler(Looper.getMainLooper()).post {
                AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(language))
            }
            return true
        }
        val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        if (prefs.getString(THEME, null) == theme) return false
        prefs.edit().putString(THEME, theme).apply()
        Handler(Looper.getMainLooper()).post { restore(context) }
        return true
    }
}
