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

    // The four app languages in registry order (i18n/locales.json). The panel
    // and the native picker both address a language by this exact code.
    val LANGUAGES = listOf("en", "ar", "pt-BR", "es-419")

    fun validLanguage(value: String) = LANGUAGES.contains(value)
    fun validTheme(value: String) = value == "light" || value == "dark"

    /**
     * Normalizes a BCP-47 tag or a bare language code. "_" and "-" both split
     * subtags and case does not matter. pt and es have one shipped form each
     * (pt-BR, es-419), so any variant of them maps there; anything that is not
     * one of the four shipped languages falls back to English.
     */
    fun fromLocale(tag: String?): String {
        val primary = tag?.replace('_', '-')?.split('-')
            ?.firstOrNull { it.isNotEmpty() }?.lowercase()
        return when (primary) {
            "ar" -> "ar"
            "pt" -> "pt-BR"
            "es" -> "es-419"
            "en" -> "en"
            else -> "en"
        }
    }

    fun language(context: Context): String {
        // Full tag, not just the language subtag, so "es-419" and "pt-BR"
        // survive; both accepted by Locale.forLanguageTag.
        val locales = AppCompatDelegate.getApplicationLocales()
        if (!locales.isEmpty) return fromLocale(locales[0]?.toLanguageTag())
        return fromLocale(context.resources.configuration.locales[0]?.toLanguageTag())
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

    // Set while the host service is alive: redraws its notification after an
    // in-app language change (see LevixHostService for why API 29-32 needs it).
    @Volatile internal var onLanguageApplied: (() -> Unit)? = null

    fun set(context: Context, language: String, theme: String, field: String): Boolean {
        if (!validLanguage(language) || !validTheme(theme) ||
            (field != LANGUAGE_FIELD && field != THEME)) return false
        if (field == LANGUAGE_FIELD) {
            val locales = AppCompatDelegate.getApplicationLocales()
            // Both sides are full tags; fromLocale puts "pt-BR" beside a stored
            // "pt-BR" again, so comparing the normalized forms is exact.
            if (!locales.isEmpty && fromLocale(locales[0]?.toLanguageTag()) == language) return false
            Handler(Looper.getMainLooper()).post {
                AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(language))
                onLanguageApplied?.invoke()
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
