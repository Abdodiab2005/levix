package net.leviro.levix

import org.junit.Assert.*
import org.junit.Test

class StickerSourcesTest {
    @Test fun tokensExpireEvictAndRemove() {
        var now = 0L
        val sources = StickerSources { now }
        val first = sources.register("content://first", "one", "image/png", 5)
        assertTrue(first.matches(Regex("[0-9a-f]{32}")))
        assertEquals("content://first", sources.get(first)?.uri)
        repeat(7) { sources.register("content://$it", "$it", "image/png", 1) }
        assertNotNull(sources.get(first))
        sources.register("content://ninth", "ninth", "image/png", 1)
        assertNull(sources.get(first))
        val token = sources.register("content://last", "last", "image/png", -1)
        sources.remove(token)
        assertNull(sources.get(token))
        val expiring = sources.register("content://expires", "expires", "video/mp4", 2)
        now += 60 * 60 * 1000L
        assertNull(sources.get(expiring))
        sources.clear()
        assertNull(sources.get(expiring))
    }
}
