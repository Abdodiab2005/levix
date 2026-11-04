package net.leviro.levix

/**
 * Pure decision for the single alert notification the host service keeps on
 * screen. It answers two questions: which alert the current state wants, and
 * whether that alert has to be (re)posted or cleared.
 *
 * The rule is "post once per entry": an alert that is already on screen is
 * posted again only when the condition itself changes kind or WhatsApp state.
 * A user who dismisses it therefore keeps it dismissed until the situation
 * changes, and an alert never survives the condition ending, whether or not
 * the session reached "connected" in between.
 */
object AlertPolicy {
    enum class Kind { TERMS, OFFLINE, WHATSAPP }

    /**
     * [state] is the WhatsApp state for [Kind.WHATSAPP], so `error` followed by
     * `logged_out` counts as a different alert and is posted. Null otherwise.
     */
    data class Alert(val kind: Kind, val state: String?)

    sealed interface Decision {
        data object Keep : Decision
        data object Cancel : Decision
        data class Post(val alert: Alert) : Decision
    }

    private const val CONSENT_REQUIRED = "consent_required"
    private const val PAUSED = "paused"
    private val FAILED_STATES = setOf("retry_exhausted", "error", "logged_out")

    fun desired(networkOnline: Boolean, whatsAppState: String?): Alert? = when {
        whatsAppState == CONSENT_REQUIRED -> Alert(Kind.TERMS, null)
        !networkOnline || whatsAppState == PAUSED -> Alert(Kind.OFFLINE, null)
        whatsAppState != null && whatsAppState in FAILED_STATES -> Alert(Kind.WHATSAPP, whatsAppState)
        else -> null
    }

    fun decide(posted: Alert?, desired: Alert?): Decision = when {
        desired == null && posted == null -> Decision.Keep
        desired == null -> Decision.Cancel
        desired == posted -> Decision.Keep
        else -> Decision.Post(desired)
    }
}
