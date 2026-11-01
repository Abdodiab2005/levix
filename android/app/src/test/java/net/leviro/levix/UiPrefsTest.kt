package net.leviro.levix

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UiPrefsTest {
    @Test fun bridgeValuesAreExact() {
        assertTrue(UiPrefs.validLanguage("ar"))
        assertTrue(UiPrefs.validLanguage("en"))
        assertTrue(UiPrefs.validLanguage("pt-BR"))
        assertTrue(UiPrefs.validLanguage("es-419"))
        assertFalse(UiPrefs.validLanguage("pt"))
        assertFalse(UiPrefs.validLanguage("es"))
        assertFalse(UiPrefs.validLanguage("PT-BR"))
        assertFalse(UiPrefs.validLanguage("PT"))
        assertFalse(UiPrefs.validLanguage("fr"))
        assertFalse(UiPrefs.validLanguage("AR"))
        assertTrue(UiPrefs.validTheme("light"))
        assertTrue(UiPrefs.validTheme("dark"))
        assertFalse(UiPrefs.validTheme("system"))
        assertFalse(UiPrefs.validTheme("LIGHT"))
    }

    @Test fun applicationLocaleResolvesToPanelLanguage() {
        assertEquals("ar", UiPrefs.fromLocale("ar"))
        assertEquals("ar", UiPrefs.fromLocale("ar-EG"))
        assertEquals("pt-BR", UiPrefs.fromLocale("pt-BR"))
        assertEquals("pt-BR", UiPrefs.fromLocale("pt-PT"))
        assertEquals("pt-BR", UiPrefs.fromLocale("pt"))
        assertEquals("es-419", UiPrefs.fromLocale("es-419"))
        assertEquals("es-419", UiPrefs.fromLocale("es-ES"))
        assertEquals("es-419", UiPrefs.fromLocale("es_MX"))
        assertEquals("en", UiPrefs.fromLocale("en-US"))
        assertEquals("en", UiPrefs.fromLocale("en"))
        assertEquals("en", UiPrefs.fromLocale("fr"))
        assertEquals("en", UiPrefs.fromLocale(null))
    }

    @Test fun languageListMatchesRegistryOrder() {
        assertEquals(listOf("en", "ar", "pt-BR", "es-419"), UiPrefs.LANGUAGES)
    }
}
