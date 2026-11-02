package net.leviro.levix

import org.junit.Assert.*
import org.junit.Test
import net.leviro.levix.AlertPolicy.Alert
import net.leviro.levix.AlertPolicy.Decision
import net.leviro.levix.AlertPolicy.Kind

class AlertPolicyTest {
    private fun wa(state: String?) = AlertPolicy.desired(true, state)

    @Test fun termsBeatsOffline() {
        assertEquals(Alert(Kind.TERMS, null), AlertPolicy.desired(false, "consent_required"))
    }
    @Test fun offlineBeatsFailure() {
        assertEquals(Alert(Kind.OFFLINE, null), AlertPolicy.desired(false, "retry_exhausted"))
        assertEquals(Alert(Kind.OFFLINE, null), AlertPolicy.desired(false, "logged_out"))
        assertEquals(Alert(Kind.OFFLINE, null), AlertPolicy.desired(false, "error"))
    }
    @Test fun termsIsTheOnlyAlertForConsent() {
        assertEquals(Alert(Kind.TERMS, null), wa("consent_required"))
    }
    @Test fun pausedIsOffline() {
        assertEquals(Alert(Kind.OFFLINE, null), wa("paused"))
    }
    @Test fun failureStatesAreWhatsAppAlertsCarryingTheState() {
        for (state in listOf("retry_exhausted", "error", "logged_out")) {
            assertEquals(Alert(Kind.WHATSAPP, state), wa(state))
        }
    }
    @Test fun quietStatesWantNoAlert() {
        val quiet = listOf(
            "connected", "idle", "starting", "linking",
            "waiting_for_qr", "reconnecting", "disconnected", null,
        )
        for (state in quiet) assertNull("state=$state", wa(state))
    }
    @Test fun equalAlertIsKeptAcrossHeartbeats() {
        val terms = Alert(Kind.TERMS, null)
        assertEquals(Decision.Keep, AlertPolicy.decide(terms, terms))
        val error = Alert(Kind.WHATSAPP, "error")
        assertEquals(Decision.Keep, AlertPolicy.decide(error, error))
        val offline = Alert(Kind.OFFLINE, null)
        assertEquals(Decision.Keep, AlertPolicy.decide(offline, offline))
    }
    @Test fun kindChangeIsPosted() {
        assertEquals(
            Decision.Post(Alert(Kind.OFFLINE, null)),
            AlertPolicy.decide(Alert(Kind.TERMS, null), Alert(Kind.OFFLINE, null)),
        )
        assertEquals(
            Decision.Post(Alert(Kind.WHATSAPP, "error")),
            AlertPolicy.decide(Alert(Kind.OFFLINE, null), Alert(Kind.WHATSAPP, "error")),
        )
    }
    @Test fun newWhatsAppStateIsPosted() {
        assertEquals(
            Decision.Post(Alert(Kind.WHATSAPP, "logged_out")),
            AlertPolicy.decide(Alert(Kind.WHATSAPP, "error"), Alert(Kind.WHATSAPP, "logged_out")),
        )
    }
    @Test fun conditionEndingWithoutConnectedCancels() {
        val cases = listOf(
            Triple(Alert(Kind.OFFLINE, null), true, "idle"),
            Triple(Alert(Kind.WHATSAPP, "logged_out"), true, "waiting_for_qr"),
            Triple(Alert(Kind.WHATSAPP, "retry_exhausted"), true, "disconnected"),
            Triple(Alert(Kind.TERMS, null), true, "idle"),
        )
        for ((posted, online, state) in cases) {
            assertEquals(
                "posted=$posted state=$state online=$online",
                Decision.Cancel,
                AlertPolicy.decide(posted, AlertPolicy.desired(online, state)),
            )
        }
    }
    @Test fun nothingPostedAndNothingWantedKeeps() {
        assertEquals(Decision.Keep, AlertPolicy.decide(null, null))
        assertEquals(Decision.Keep, AlertPolicy.decide(null, AlertPolicy.desired(true, "connected")))
    }
    @Test fun firstAlertIsPosted() {
        assertEquals(
            Decision.Post(Alert(Kind.TERMS, null)),
            AlertPolicy.decide(null, AlertPolicy.desired(true, "consent_required")),
        )
    }
}
