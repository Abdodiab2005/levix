package net.leviro.levix

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UiPrefsTest {
    @Test fun bridgeValuesAreExact() {
        assertTrue(UiPrefs.validLanguage("ar"))
        assertTrue(UiPrefs.validLanguage("en"))
        assertFalse(UiPrefs.validLanguage("AR"))
        assertFalse(UiPrefs.validLanguage("fr"))
        assertTrue(UiPrefs.validTheme("light"))
        assertTrue(UiPrefs.validTheme("dark"))
        assertFalse(UiPrefs.validTheme("system"))
        assertFalse(UiPrefs.validTheme("LIGHT"))
    }

    @Test fun applicationLocaleResolvesToPanelLanguage() {
        assertEquals("ar", UiPrefs.fromLocale("ar"))
        assertEquals("ar", UiPrefs.fromLocale("ar-EG"))
        assertEquals("en", UiPrefs.fromLocale("en-US"))
        assertEquals("en", UiPrefs.fromLocale("fr"))
        assertEquals("en", UiPrefs.fromLocale(null))
    }
}
