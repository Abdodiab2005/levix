package net.leviro.levix

import net.leviro.levix.media.PendingStickers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bridge's file rules, on their own. They are the only thing between a name
 * or a MIME type typed into the panel WebView and a file in the app's cache, so
 * every refusal is pinned here rather than only reachable through a WebView.
 */
class PanelFilesTest {
    @Test
    fun sharedMimeAcceptsOnlyTheStickerAllowlist() {
        for (mime in listOf("application/zip", "image/gif", "image/png", "image/webp", "video/mp4")) {
            assertEquals(mime, PanelFiles.sharedMime(mime))
        }
        // Case and surrounding whitespace come straight off a File.blob.type.
        assertEquals("image/webp", PanelFiles.sharedMime("  IMAGE/WEBP "))
        // Media types carry parameters; the type is what is allowlisted.
        assertEquals("video/mp4", PanelFiles.sharedMime("video/mp4; codecs=\"avc1\""))
        assertEquals("image/gif", PanelFiles.sharedMime("image/gif;charset=utf-8"))
    }

    @Test
    fun sharedMimeRefusesAnythingElse() {
        for (mime in listOf(
            "",
            "   ",
            "*/*",
            "application/octet-stream",
            "application/javascript",
            "text/html",
            "text/plain",
            "image/jpeg",
            "image/svg+xml",
            "video/mp2t",
            "audio/mpeg",
            "application/x-apk",
            "application/zip.evil",
            "zip",
        )) {
            assertNull("\"$mime\" must not be shareable", PanelFiles.sharedMime(mime))
        }
    }

    @Test
    fun sanitizeNameKeepsAnOrdinaryNameIntact() {
        assertEquals("cat.jpg", PanelFiles.sanitizeName("cat.jpg"))
        assertEquals("Sticker Studio.webp", PanelFiles.sanitizeName(" Sticker Studio.webp "))
        assertEquals("صورة.png", PanelFiles.sanitizeName("صورة.png"))
        assertEquals("a-b_c(1).gif", PanelFiles.sanitizeName("a-b_c(1).gif"))
        assertEquals("s.d.video.mp4", PanelFiles.sanitizeName("s.d.video.mp4"))
    }

    @Test
    fun sanitizeNameReplacesSeparatorsAndControlCharacters() {
        assertEquals("a_b", PanelFiles.sanitizeName("a/b"))
        assertEquals("a_b", PanelFiles.sanitizeName("a\\b"))
        assertEquals("a_b", PanelFiles.sanitizeName("a:b"))
        assertEquals("no_traversal", PanelFiles.sanitizeName("/no/traversal"))
        assertEquals("etc_passwd", PanelFiles.sanitizeName("..\\..\\etc\\passwd"))
        // The punctuation Windows and FAT reject, and the control characters a
        // path never survives, all become one underscore.
        assertEquals("a_b", PanelFiles.sanitizeName("a*b"))
        assertEquals("a_b", PanelFiles.sanitizeName("a?b"))
        assertEquals("a_b", PanelFiles.sanitizeName("a\"b"))
        assertEquals("a_b", PanelFiles.sanitizeName("a<b"))
        assertEquals("a_b", PanelFiles.sanitizeName("a>b"))
        assertEquals("a_b", PanelFiles.sanitizeName("a|b"))
        assertEquals("a_b", PanelFiles.sanitizeName("a\u0000b"))
        assertEquals("a_b", PanelFiles.sanitizeName("a\u0001b"))
        assertEquals("a_b", PanelFiles.sanitizeName("a\u001fb"))
        assertEquals("a_b", PanelFiles.sanitizeName("a\nb"))
        assertEquals("a_b", PanelFiles.sanitizeName("a\tb"))
        // Runs collapse, so a name cannot be padded out with underscores.
        assertEquals("a_b", PanelFiles.sanitizeName("a///___b"))
    }

    @Test
    fun sanitizeNameCannotEscapeItsFolderOrHideTheFile() {
        for (raw in listOf("a/b", "a\\b", "/no/traversal", "..\\..\\etc\\passwd", "a\u0000b")) {
            val safe = PanelFiles.sanitizeName(raw)
            assertFalse("\"$raw\" kept a separator", safe.contains('/'))
            assertFalse("\"$raw\" kept a backslash", safe.contains('\\'))
            assertFalse("\"$raw\" kept a dot segment", safe.contains(".."))
            assertFalse("\"$raw\" is hidden", safe.startsWith('.'))
            assertTrue("\"$raw\" kept a control character", safe.none { it < ' ' })
        }
        // A leading dot would hide the file from every file manager.
        assertEquals("hidden.jpg", PanelFiles.sanitizeName(".hidden.jpg"))
        assertEquals("photos", PanelFiles.sanitizeName(".photos"))
        assertEquals("photo.jpg", PanelFiles.sanitizeName("/photo.jpg"))
    }

    @Test
    fun sanitizeNameFallsBackWhenNothingIsLeft() {
        for (raw in listOf("", "   ", ".", "...", "....", ". . .", "\t\n ")) {
            assertEquals(
                "\"$raw\" should fall back",
                "levix-file",
                PanelFiles.sanitizeName(raw),
            )
        }
        assertEquals("fallback.png", PanelFiles.sanitizeName("...", fallback = "fallback.png"))
    }

    @Test
    fun sanitizeNameCapsTheLength() {
        assertEquals(120, PanelFiles.sanitizeName("n".repeat(400) + ".webp").length)
        assertEquals(120, PanelFiles.sanitizeName("a/b/".repeat(200)).length)
        assertEquals(120, PanelFiles.sanitizeName("n".repeat(120)).length)
        assertEquals(119, PanelFiles.sanitizeName("n".repeat(119)).length)
        // Capping happens after cleaning, so a long name never ends mid-escape
        // with a separator still in it.
        assertFalse(PanelFiles.sanitizeName("a/".repeat(200) + "b").contains('/'))
    }

    @Test
    fun fitsBridgeCapIsInclusiveAtBothEnds() {
        assertFalse(PanelFiles.fitsBridgeCap(0))
        assertFalse(PanelFiles.fitsBridgeCap(-1))
        assertTrue(PanelFiles.fitsBridgeCap(1))
        assertTrue(PanelFiles.fitsBridgeCap(PanelFiles.MAX_BRIDGE_BYTES - 1))
        assertTrue(PanelFiles.fitsBridgeCap(PanelFiles.MAX_BRIDGE_BYTES))
        assertFalse(PanelFiles.fitsBridgeCap(PanelFiles.MAX_BRIDGE_BYTES + 1))
        // One cap, written twice: what the bridge will carry out is what the
        // Media Hub will hand in, and it mirrors Sticker Studio's upload limit.
        assertEquals(16L * 1024 * 1024, PanelFiles.MAX_BRIDGE_BYTES)
        assertEquals(PendingStickers.MAX_BYTES, PanelFiles.MAX_BRIDGE_BYTES)
    }

    @Test
    fun encodedFitsCapRefusesBeforeDecoding() {
        // 4 base64 characters per 3 bytes, plus slack for padding and wrapping.
        val atCap = (PanelFiles.MAX_BRIDGE_BYTES / 3 * 4).toInt()
        val limit = atCap + 1024
        assertTrue(PanelFiles.encodedFitsCap(""))
        assertTrue(PanelFiles.encodedFitsCap("A".repeat(atCap)))
        assertTrue(PanelFiles.encodedFitsCap("A".repeat(limit)))
        assertFalse(PanelFiles.encodedFitsCap("A".repeat(limit + 1)))
        // A file at the cap encodes under the bar; that is what the slack is
        // for, and losing it would refuse a legal 16 MB sticker.
        assertTrue(atCap < limit)
    }
}
