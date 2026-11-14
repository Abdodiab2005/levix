package net.leviro.levix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The official-link allowlist. Every allowed value is asserted to survive
 * validation unchanged; every hostile shape a panel page (or a redirection
 * through one) could hand the opener is refused. Validation is pure, so no
 * intent is launched and no network is touched here.
 */
class OfficialLinksTest {
    @Test
    fun fixedDestinationsAreAllowedExactly() {
        for (url in listOf(
            OfficialLinks.WEBSITE,
            OfficialLinks.DOCS,
            OfficialLinks.SUPPORT,
            OfficialLinks.STUDIO,
            OfficialLinks.PORTFOLIO,
            OfficialLinks.GITHUB,
            OfficialLinks.RELEASES,
            OfficialLinks.PLAY,
        )) {
            assertEquals(url, OfficialLinks.validate(url))
            assertTrue(OfficialLinks.isOfficial(url))
        }
        assertEquals("https://levix.leviro.net", OfficialLinks.WEBSITE)
        assertEquals("https://levix.leviro.net/docs", OfficialLinks.DOCS)
        assertEquals("https://levix.leviro.net/feedback", OfficialLinks.SUPPORT)
        assertEquals("https://leviro.net", OfficialLinks.STUDIO)
        assertEquals("https://abdelrhman.leviro.net", OfficialLinks.PORTFOLIO)
        assertEquals("https://github.com/Abdodiab2005/levix", OfficialLinks.GITHUB)
        assertEquals("https://github.com/Abdodiab2005/levix/releases", OfficialLinks.RELEASES)
        assertEquals(
            "https://play.google.com/store/apps/details?id=net.leviro.levix",
            OfficialLinks.PLAY,
        )
    }

    @Test
    fun releaseDetailsAllowStrictSemverWithOptionalV() {
        val prefix = "https://github.com/Abdodiab2005/levix/releases/tag/"
        for (tag in listOf(
            "1.2.3",
            "v1.2.3",
            "v0.0.0",
            "v10.20.30",
            "v5.0.0-beta.1",
            "v1.2.3-rc.1+build.5",
            "v1.2.3+build.5",
            "v1.0.0-alpha-x.1",
        )) {
            val url = prefix + tag
            assertEquals(url, OfficialLinks.validate(url))
        }
    }

    @Test
    fun releaseDetailsRejectEverythingButOneStrictTag() {
        val prefix = "https://github.com/Abdodiab2005/levix/releases/tag/"
        for (tag in listOf(
            "",
            "v",
            "v1",
            "v1.2",
            "v1.2.3.4",
            "v01.2.3",
            "v1.02.3",
            "v1.2.03",
            "v1.2.3-",
            "v1.2.3-01",
            "v1.2.3+",
            "v1.2.3+bad..build",
            "v1.2.3/",
            "v1.2.3/extra",
            "latest",
            "v1.2.3?draft=1",
            "v1.2.3#notes",
        )) {
            assertNull("tag=$tag", OfficialLinks.validate(prefix + tag))
        }
        // A release tag is the only variable GitHub path; sibling pages are not.
        for (path in listOf(
            "/Abdodiab2005/levix/releases/latest",
            "/Abdodiab2005/levix/releases/download/v1.2.3/levix.apk",
            "/Abdodiab2005/levix/tree/main",
            "/Abdodiab2005/levix/releases/tag/../../settings",
        )) {
            assertNull("path=$path", OfficialLinks.validate("https://github.com$path"))
        }
    }

    @Test
    fun credentialsPortsFragmentsQueriesAndSchemesAreRejected() {
        for (url in listOf(
            "",
            " ",
            "website",
            "https://levix.leviro.net ",
            " https://levix.leviro.net",
            "https://levix.leviro.net\n",
            "https://levix.leviro.net\t",
            "http://levix.leviro.net",
            "ftp://levix.leviro.net",
            "file:///data/data/net.leviro.levix",
            "javascript:alert(1)",
            "intent://scan/#Intent;scheme=zxing;end",
            "//levix.leviro.net",
            "https://user@levix.leviro.net",
            "https://user:pass@levix.leviro.net",
            "https://levix.leviro.net:443/docs",
            "https://levix.leviro.net:8443/docs",
            "https://levix.leviro.net/docs#x",
            "https://levix.leviro.net/docs?x=1",
            "https://levix.leviro.net/docs/",
            "https://levix.leviro.net/feedback?x=1",
            "https://levix.leviro.net/",
            "https://leviro.net/",
            "https://abdelrhman.leviro.net/",
            "https://github.com/Abdodiab2005/levix/",
            "https://github.com/Abdodiab2005/levix?tab=readme",
            "https://github.com/Abdodiab2005/levix#readme",
            "https://github.com:443/Abdodiab2005/levix",
            "https://user@github.com/Abdodiab2005/levix",
            "https://play.google.com/store/apps/details?id=net.leviro.levix&hl=en",
            "https://play.google.com/store/apps/details?id=evil",
            "https://play.google.com/store/apps/details",
        )) {
            assertNull("url=$url", OfficialLinks.validate(url))
            assertFalse("url=$url", OfficialLinks.isOfficial(url))
        }
    }

    @Test
    fun lookalikeHostsAndPathEscapesAreRejected() {
        for (url in listOf(
            "https://levix.leviro.net.evil.com",
            "https://evil.levix.leviro.net",
            "https://evil-levix.leviro.net",
            "https://levix.leviro.net@evil.com",
            "https://github.com.evil.com/Abdodiab2005/levix",
            "https://github.com/Abdodiab2005/levix@evil.com",
            "https://gіthub.com/Abdodiab2005/levix",
            "https://levix.leviro.net/docs/../feedback",
            "https://levix.leviro.net/docs/%2e%2e/feedback",
            "https://github.com/Abdodiab2005/levix/releases/tag/v1.2.3%2f..%2f..",
            "https://github.com/Abdodiab2005/levix/releases/tag/v1.2.3/../../tree/main",
            "https://github.com/Abdodiab2005/levix\\@evil.com",
            "https://github.com/Ab%64odiab2005/levix",
        )) {
            assertNull("url=$url", OfficialLinks.validate(url))
        }
    }

    @Test
    fun oversizedInputIsRefusedBeforeItReachesAnIntent() {
        val tooLong = "https://levix.leviro.net/" + "a".repeat(600)
        assertNull(OfficialLinks.validate(tooLong))
        assertNull(OfficialLinks.validate("x".repeat(10_000)))
    }
}
