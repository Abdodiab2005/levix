package net.leviro.levix

import android.content.Intent
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class DiagnosticsTest {
    @Test fun sanitizerRedactsEverySensitivePattern() {
        val sample = "201234567890@s.whatsapp.net a@example.com +201234567890 " +
            "https://example.com/private?key=abc ABCD1234EFGH5678IJKL9012 " +
            "/home/alice/data/levix.db /home/alice/other\nend"
        val clean = CrashSanitizer.text(sample, 500, "/home/alice/data", "/home/alice")
        assertTrue(clean.contains("<jid>"))
        assertTrue(clean.contains("<email>"))
        assertTrue(clean.contains("<number>"))
        assertTrue(clean.contains("https://example.com/<path>"))
        assertEquals("https://123456789.com/<path>",
            CrashSanitizer.text("https://123456789.com/private", 100))
        assertTrue(clean.contains("<secret>"))
        assertEquals("IllegalArgumentException",
            CrashSanitizer.text("IllegalArgumentException", 120))
        assertTrue(clean.contains("<data>/levix.db"))
        assertTrue(clean.contains("~/otherend"))
        assertFalse(clean.contains('\n'))
        assertEquals(4, CrashSanitizer.text("abcdef", 4).length)
    }

    @Test fun fingerprintUsesCategoryTypeAndFirstThreeFrames() {
        val frames = listOf("one", "two", "three", "four")
        val fp = CrashSanitizer.fingerprint("android-crash", "IllegalState", frames)
        assertTrue(fp.matches(Regex("[0-9a-f]{16}")))
        assertEquals(fp, CrashSanitizer.fingerprint("android-crash", "IllegalState", frames.take(3)))
        assertNotEquals(fp, CrashSanitizer.fingerprint("android-anr", "IllegalState", frames))
        assertNotEquals(fp, CrashSanitizer.fingerprint("android-crash", "Other", frames))
    }

    @Test fun reportShapeAndCap() {
        val report = CrashReports.reportJson("0123456789abcdef", "2026-10-12T19:04:05.000Z",
            "android-crash", "IllegalState", "safe", listOf("frame"), "MainActivity",
            mapOf("platform" to "android"), mapOf("android" to "15 (API 35)"), JSONArray())
        assertEquals(1, report.getInt("schema"))
        assertEquals("pending", report.getString("status"))
        assertTrue(report.isNull("lastError"))
        assertEquals(16, report.getString("fingerprint").length)
        assertEquals("safe", report.getJSONObject("error").getString("message"))
        assertEquals("MainActivity", report.getString("screen"))
        assertEquals("android", report.getJSONObject("app").getString("platform"))
        assertEquals("15 (API 35)", report.getJSONObject("device").getString("android"))
        assertEquals(0, report.getJSONArray("breadcrumbs").length())
        val dir = Files.createTempDirectory("levix-crash-test").toFile()
        try {
            for (index in 0..20) {
                val id = "%016x".format(index)
                val entry = CrashReports.reportJson(id, "2026-10-12T19:04:05.000Z",
                    "android-crash", "Error", "safe", emptyList(), null,
                    emptyMap(), emptyMap(), JSONArray())
                assertTrue(CrashReports.write(dir, entry))
                File(dir, "$id.json").setLastModified(1_000L + index)
            }
            assertEquals(20, CrashReports.pendingFiles(dir).size)
            assertFalse(File(dir, "0000000000000000.json").exists())
            assertTrue(File(dir, "0000000000000014.json").exists())
            assertTrue(dir.listFiles()!!.none { it.name.endsWith(".tmp") })
        } finally { dir.deleteRecursively() }
    }

    @Test fun sweepRemovesExpiredAndKeepsNewest() {
        val dir = Files.createTempDirectory("levix-sweep-test").toFile()
        try {
            for (index in 0..22) {
                File(dir, "%016x.json".format(index)).apply {
                    writeText("{}")
                    setLastModified(index * 1_000L)
                }
            }
            CrashReports.sweep(dir, 7L * 24 * 60 * 60 * 1000 + 2_000L)
            val files = CrashReports.pendingFiles(dir)
            assertEquals(20, files.size)
            assertEquals("0000000000000003.json", files.first().name)
            assertEquals("0000000000000016.json", files.last().name)
        } finally { dir.deleteRecursively() }
    }

    @Test fun onboardingOnlyOnUnfinishedLauncherVisit() {
        assertTrue(OnboardingGate.shouldShow(Intent.ACTION_MAIN, true, false, false))
        assertFalse(OnboardingGate.shouldShow(Intent.ACTION_MAIN, true, false, true))
        assertFalse(OnboardingGate.shouldShow(Intent.ACTION_MAIN, true, true, false))
        assertFalse(OnboardingGate.shouldShow(Intent.ACTION_VIEW, false, false, false))
        assertFalse(OnboardingGate.shouldShow(Intent.ACTION_MAIN, false, false, false))
    }

    @Test fun diagnosticsFormattingHasUnknownFallbacks() {
        assertEquals("15 (API 35)", DeviceDiagnostics.formatAndroid("15", 35))
        assertEquals("unknown", DeviceDiagnostics.formatAndroid(null, 35))
        assertEquals("unknown", DeviceDiagnostics.formatAndroid("15", 0))
        assertEquals("samsung SM-A556E", DeviceDiagnostics.formatDevice("samsung", "SM-A556E"))
        assertEquals("unknown", DeviceDiagnostics.formatDevice("samsung", null))
        assertEquals("low", DeviceDiagnostics.storageStatus(400L * 1024 * 1024, 20L * 1024 * 1024 * 1024))
        assertEquals("low", DeviceDiagnostics.storageStatus(600L * 1024 * 1024, 10L * 1024 * 1024 * 1024))
        assertEquals("ok", DeviceDiagnostics.storageStatus(2L * 1024 * 1024 * 1024, 10L * 1024 * 1024 * 1024))
        assertEquals("unknown", DeviceDiagnostics.storageStatus(-1, 100))
    }
}
