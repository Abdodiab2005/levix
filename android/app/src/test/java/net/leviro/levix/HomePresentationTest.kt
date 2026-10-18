package net.leviro.levix

import org.junit.Assert.*
import org.junit.Test
import net.leviro.levix.HomePresentation.Action
import net.leviro.levix.HomePresentation.State

class HomePresentationTest {
    private val now = 500_000L
    private fun ready(wa: String? = "idle") = HostState.Snapshot(
        running = true, startedAtMs = now - 1_000, nodeAlive = true,
        levixReady = true, panelUrl = "http://127.0.0.1:3001/", whatsAppState = wa,
        whatsAppSinceMs = now - 1_000,
    )
    private fun check(s: HostState.Snapshot, state: State, action: Action) {
        val home = HomePresentation.from(s, now)
        assertEquals(state, home.state)
        assertEquals(action, home.action)
    }
    @Test fun stoppedStartsOnly() = check(HostState.Snapshot(), State.STOPPED, Action.START)
    @Test fun pendingRequestCannotStartTwice() {
        val home = HomePresentation.from(HostState.Snapshot(), now, now - 1)
        assertEquals(Action.NONE, home.action)
        assertTrue(home.busy)
    }
    @Test fun pendingRequestTimesOut() {
        val home = HomePresentation.from(HostState.Snapshot(), now, now - HomePresentation.WAIT_MS)
        assertEquals(State.FAILED, home.state)
        assertEquals(Action.START, home.action)
        assertFalse(home.busy)
    }
    @Test fun processIsNotReady() = check(ready("connected").copy(levixReady = false), State.STARTING, Action.NONE)
    @Test fun pairingRequired() {
        for (wa in listOf("idle", "waiting_for_qr")) check(ready(wa), State.PAIRING, Action.CONNECTION)
    }
    @Test fun connectedOpensPanel() = check(ready("connected"), State.READY, Action.PANEL)
    @Test fun reconnectingDoesNotRestartEngine() = check(ready("reconnecting"), State.RECONNECTING, Action.CONNECTION)
    @Test fun pausedDoesNotRestartEngine() = check(ready("paused"), State.PAUSED, Action.CONNECTION)
    @Test fun terminalSessionFailuresOpenConnection() {
        for (wa in listOf("disconnected", "retry_exhausted", "error")) check(ready(wa), State.FAILED, Action.CONNECTION)
    }
    @Test fun loggedOutNeedsPairing() = check(ready("logged_out"), State.EXPIRED, Action.CONNECTION)
    @Test fun startupFailureOpensDiagnostics() = check(ready("connected").copy(nodeError = "failed"), State.FAILED, Action.DIAGNOSTICS)
    @Test fun unknownIsNeverReady() {
        for (wa in listOf(null, "future_state", "")) check(ready(wa), State.UNKNOWN, Action.CONNECTION)
    }
    @Test fun incompleteEngineTimesOut() = check(ready("connected").copy(nodeAlive = false, startedAtMs = now - HomePresentation.WAIT_MS), State.UNKNOWN, Action.DIAGNOSTICS)
    @Test fun linkingTimesOutWithoutDestructiveRecovery() {
        check(ready("linking"), State.STARTING, Action.CONNECTION)
        check(ready("linking").copy(whatsAppSinceMs = now - HomePresentation.WAIT_MS), State.UNKNOWN, Action.CONNECTION)
    }
    @Test fun staleConnectionAfterStopCannotWin() = check(ready("connected").copy(running = false), State.STOPPED, Action.START)
    @Test fun stateSequenceRecovers() {
        listOf(ready(), ready("connected"), ready("paused"), ready("reconnecting"), ready("connected"), HostState.Snapshot())
            .zip(listOf(State.PAIRING, State.READY, State.PAUSED, State.RECONNECTING, State.READY, State.STOPPED))
            .forEach { (s, expected) -> assertEquals(expected, HomePresentation.from(s, now).state) }
    }
    @Test fun deadEngineInvalidatesReadinessAndLateEventsAfterStop() {
        try {
            HostState.markStarted()
            HostState.markPanelListening("http://127.0.0.1:3001/")
            HostState.markLevixReady()
            HostState.setWhatsAppStatus("connected", null, null)
            HostState.setWhatsAppStatus("error", 405, "refused")
            HostState.markNodeError("exit")
            assertFalse(HostState.snapshot.levixReady)
            assertNull(HostState.snapshot.whatsAppState)
            assertNull(HostState.snapshot.whatsAppCode)
            assertNull(HostState.snapshot.whatsAppReason)
            HostState.markNodeStarting()
            assertNull(HostState.snapshot.panelUrl)
            HostState.markStopped()
            HostState.markLevixReady()
            HostState.markPanelListening("http://127.0.0.1:3001/")
            HostState.setWhatsAppStatus("connected", null, null)
            assertEquals(HostState.Snapshot(), HostState.snapshot)
        } finally { HostState.markStopped() }
    }
}
