package net.leviro.levix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Capture turns off only from [ScreenCaptureGuard.onPageFinished] when the
 * pending decision is for that document and the header value trims to the
 * exact token `allow`. A second header entry, or a comma-joined repeat, fails
 * closed. A finish with no pending decision, or for another URL, does not
 * call apply and does not drop a pending decision.
 */
class ScreenCaptureGuardTest {
    private class Rec {
        val calls = mutableListOf<Boolean>()
        val guard = ScreenCaptureGuard { secure -> calls.add(secure) }
        fun denied() = calls.count { !it }
    }

    @Test fun startIsSecure() {
        val rec = Rec()
        assertTrue(rec.guard.secure)
        rec.guard.start()
        assertTrue(rec.guard.secure)
        assertEquals(listOf(true), rec.calls.toList())
    }

    @Test fun setupAtRootStaysSecure() {
        val rec = drive(ROOT, null)
        assertTrue(rec.guard.secure)
        assertEquals(0, rec.denied())
    }

    @Test fun setupAtSetupPathStaysSecure() {
        val rec = drive("http://127.0.0.1:3001/setup/", emptyMap())
        assertTrue(rec.guard.secure)
        assertEquals(0, rec.denied())
    }

    @Test fun loginRenderedAtRootStaysSecure() {
        val rec = drive(ROOT, mapOf("Cache-Control" to "no-store"))
        assertTrue(rec.guard.secure)
        assertEquals(0, rec.denied())
    }

    @Test fun dashboardAllowsCaptureOnlyAfterFinish() {
        val rec = Rec()
        rec.guard.start()
        rec.guard.onMainFrameResponse(ROOT, allow())
        assertTrue(rec.guard.secure)
        rec.guard.onPageStarted("$ROOT#connection")
        assertTrue(rec.guard.secure)
        assertEquals(0, rec.denied())
        rec.guard.onPageFinished("$ROOT#connection")
        assertFalse(rec.guard.secure)
        assertEquals(1, rec.denied())
    }

    @Test fun signOutAtTheSameUrlIsSecureFromTheResponse() {
        val rec = Rec()
        rec.guard.onMainFrameResponse(ROOT, allow())
        rec.guard.onPageStarted(ROOT)
        rec.guard.onPageFinished(ROOT)
        assertFalse(rec.guard.secure)
        val opened = rec.denied()

        rec.guard.onMainFrameResponse(ROOT, emptyMap())
        assertTrue(rec.guard.secure)
        assertEquals(opened, rec.denied())
        rec.guard.onPageStarted(ROOT)
        rec.guard.onPageFinished(ROOT)
        assertTrue(rec.guard.secure)
        assertEquals(opened, rec.denied())
    }

    @Test fun hashFinishLeavesACapturableDashboardCapturable() {
        val rec = Rec()
        rec.guard.onMainFrameResponse(ROOT, allow())
        rec.guard.onPageStarted(ROOT)
        rec.guard.onPageFinished(ROOT)
        assertFalse(rec.guard.secure)
        val calls = rec.calls.size
        rec.guard.onPageFinished("http://127.0.0.1:3001/#settings")
        assertFalse(rec.guard.secure)
        assertEquals(calls, rec.calls.size)
    }

    @Test fun loginFragmentFinishStaysSecure() {
        val rec = drive(ROOT, emptyMap())
        assertTrue(rec.guard.secure)
        val calls = rec.calls.size
        rec.guard.onPageFinished("$ROOT#settings")
        assertTrue(rec.guard.secure)
        assertEquals(calls, rec.calls.size)
    }

    @Test fun historyMoveGoesSecureOnStart() {
        val rec = Rec()
        rec.guard.onMainFrameResponse(ROOT, allow())
        rec.guard.onPageStarted(ROOT)
        rec.guard.onPageFinished(ROOT)
        assertFalse(rec.guard.secure)
        rec.guard.onPageStarted(ROOT)
        assertTrue(rec.guard.secure)
        val calls = rec.calls.size
        rec.guard.onPageFinished(ROOT)
        assertTrue(rec.guard.secure)
        assertEquals(calls, rec.calls.size)
    }

    @Test fun errorDropsAPendingAllow() {
        val rec = Rec()
        rec.guard.onMainFrameResponse(ROOT, allow())
        rec.guard.onMainFrameError()
        rec.guard.onPageStarted(ROOT)
        rec.guard.onPageFinished(ROOT)
        assertTrue(rec.guard.secure)
        assertEquals(0, rec.denied())
    }

    @Test fun pendingAllowForAnotherUrlIsNotApplied() {
        val rec = Rec()
        val qr = "http://127.0.0.1:3001/qr"
        rec.guard.onMainFrameResponse(qr, allow())
        val calls = rec.calls.size
        rec.guard.onPageFinished(ROOT)
        assertTrue(rec.guard.secure)
        assertEquals(calls, rec.calls.size)
        rec.guard.onPageFinished(qr)
        assertFalse(rec.guard.secure)
        assertEquals(false, rec.calls.last())
    }

    @Test fun fragmentOnTheResponseMatchesABareFinish() {
        val rec = Rec()
        rec.guard.onMainFrameResponse("$ROOT#connection", allow())
        rec.guard.onPageStarted(ROOT)
        rec.guard.onPageFinished(ROOT)
        assertFalse(rec.guard.secure)
    }

    @Test fun queryIsPartOfTheDocument() {
        val rec = Rec()
        rec.guard.onMainFrameResponse("$ROOT?next=1", allow())
        rec.guard.onPageFinished(ROOT)
        assertTrue(rec.guard.secure)
        assertEquals(0, rec.denied())
    }

    @Test fun headerNameIsCaseInsensitive() {
        val rec = drive(ROOT, mapOf("x-LeViX-sCreen-cApture" to "allow"))
        assertFalse(rec.guard.secure)
    }

    @Test fun headerValuesFailClosedExceptTrimmedAllow() {
        val cases = listOf(
            "allow" to false,
            " allow " to false,
            "ALLOW " to true,
            "Allow" to true,
            "deny" to true,
            "" to true,
            "allow, allow" to true,
            "allow,allow" to true,
        )
        for ((value, staysSecure) in cases) {
            val rec = drive(ROOT, mapOf(HEADER to value))
            assertEquals("value=$value", staysSecure, rec.guard.secure)
        }
    }

    @Test fun duplicatedHeaderNamesFailClosed() {
        val headers = linkedMapOf(
            HEADER to "allow",
            "x-levix-screen-capture" to "allow",
        )
        val rec = drive(ROOT, headers)
        assertTrue(rec.guard.secure)
        assertEquals(0, rec.denied())
    }

    @Test fun nullHeadersStaySecure() {
        val rec = drive(ROOT, null)
        assertTrue(rec.guard.secure)
    }

    private fun allow(): Map<String, String> = mapOf(HEADER to "allow")

    private fun drive(url: String, headers: Map<String, String>?): Rec {
        val rec = Rec()
        rec.guard.start()
        rec.guard.onMainFrameResponse(url, headers)
        assertTrue(rec.guard.secure)
        rec.guard.onPageStarted(url)
        assertTrue(rec.guard.secure)
        rec.guard.onPageFinished(url)
        return rec
    }

    private companion object {
        const val ROOT = "http://127.0.0.1:3001/"
        const val HEADER = "X-Levix-Screen-Capture"
    }
}
