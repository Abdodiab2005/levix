package net.leviro.levix

/** Pure projection: a live process is not evidence of a ready engine or a linked account. */
internal data class HomePresentation(
    val state: State,
    val title: Int,
    val body: Int,
    val action: Action,
    val actionLabel: Int,
    val step: Int,
    val busy: Boolean = false,
) {
    enum class State { STOPPED, STARTING, PAIRING, READY, RECONNECTING, PAUSED, FAILED, EXPIRED, UNKNOWN }
    enum class Action { START, CONNECTION, PANEL, DIAGNOSTICS, NONE }

    companion object {
        const val WAIT_MS = 120_000L

        fun from(s: HostState.Snapshot, now: Long, requestedAt: Long = 0L): HomePresentation {
            fun view(state: State, title: Int, body: Int, action: Action, label: Int, step: Int, busy: Boolean = false) =
                HomePresentation(state, title, body, action, label, step, busy)
            if (!s.running) {
                if (requestedAt > 0L) {
                    if (now - requestedAt < WAIT_MS) return view(State.STARTING, R.string.home_starting, R.string.home_starting_body, Action.NONE, R.string.home_starting, 1, true)
                    return view(State.FAILED, R.string.home_engine_failed, R.string.home_start_timeout, Action.START, R.string.btn_start_host, 1)
                }
                return view(State.STOPPED, R.string.home_stopped, R.string.home_stopped_body, Action.START, R.string.btn_start_host, 1)
            }
            if (s.nodeError != null) return view(State.FAILED, R.string.home_engine_failed, R.string.home_engine_error_body, Action.DIAGNOSTICS, R.string.section_diagnostics_short, 1)
            val ready = s.nodeAlive && s.levixReady && s.panelUrl != null
            if (!ready) {
                if (s.startedAtMs <= 0L || now - s.startedAtMs >= WAIT_MS) return view(State.UNKNOWN, R.string.home_unknown, R.string.home_start_timeout, Action.DIAGNOSTICS, R.string.section_diagnostics_short, 1)
                return view(State.STARTING, R.string.home_starting, R.string.home_starting_body, Action.NONE, R.string.home_starting, 1, true)
            }
            return when (s.whatsAppState) {
                "connected" -> view(State.READY, R.string.home_ready, R.string.home_ready_body, Action.PANEL, R.string.btn_open_panel, 3)
                "idle", "waiting_for_qr" -> view(State.PAIRING, R.string.home_pairing, R.string.home_pairing_body, Action.CONNECTION, R.string.home_connect, 2)
                "reconnecting" -> view(State.RECONNECTING, R.string.status_reconnecting, R.string.home_reconnecting_body, Action.CONNECTION, R.string.home_connection_details, 2)
                "paused" -> view(State.PAUSED, R.string.status_paused, R.string.home_paused_body, Action.CONNECTION, R.string.home_connection_details, 2)
                "logged_out" -> view(State.EXPIRED, R.string.status_expired, R.string.home_expired_body, Action.CONNECTION, R.string.home_connect, 2)
                "disconnected", "retry_exhausted", "error" -> view(State.FAILED, R.string.home_connection_failed, R.string.home_connection_error_body, Action.CONNECTION, R.string.home_connection_details, 2)
                "starting", "linking" -> {
                    if (s.whatsAppSinceMs > 0L && now - s.whatsAppSinceMs < WAIT_MS)
                        view(State.STARTING, R.string.home_linking, R.string.home_linking_body, Action.CONNECTION, R.string.home_connection_details, 2, true)
                    else view(State.UNKNOWN, R.string.home_unknown, R.string.home_unknown_body, Action.CONNECTION, R.string.home_connection_details, 2)
                }
                else -> view(State.UNKNOWN, R.string.home_unknown, R.string.home_unknown_body, Action.CONNECTION, R.string.home_connection_details, 2)
            }
        }
    }
}
