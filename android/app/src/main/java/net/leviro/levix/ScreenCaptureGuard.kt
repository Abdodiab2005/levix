package net.leviro.levix

/**
 * Screen capture follows one server-declared decision per document, and the
 * default is secure.
 *
 * A panel URL cannot tell login from the signed-in dashboard: both can be
 * served at the same address. The main-frame response carries
 * `X-Levix-Screen-Capture: allow` only for a document that may be captured.
 * [start], [onMainFrameResponse], [onPageStarted] and [onMainFrameError] make
 * the window secure immediately. A decision is committed by a matching
 * [onPageStarted] and applied by a matching [onPageFinished]. This relies on
 * the response arriving before the start, followed by the finish. If that
 * order differs, the window stays secure. URLs are matched without fragments;
 * capture is allowed only when the header value is exactly `allow` after trim.
 *
 * A finish with no pending decision, or for another document, changes nothing
 * and does not call [apply]. WebView reports a same-document hash move
 * (`#settings`, `#connection`) as [onPageFinished] alone, with no
 * [onPageStarted] and no new response, so a capturable dashboard stays
 * capturable. A real navigation is already secure from [onPageStarted] or
 * [onMainFrameResponse].
 *
 * A duplicated header fails closed. Two map entries whose names match
 * case-insensitively, or one value that is not exactly `allow` after trim
 * (including a comma-joined repeat such as `allow, allow`), do not allow
 * capture. Header names are compared case-insensitively; the value is not.
 *
 * The lock is released before [apply], so the host can wait for the main
 * thread inside [apply] without deadlocking against these methods.
 */
class ScreenCaptureGuard(
    private val apply: (secure: Boolean) -> Unit,
) {
    private val lock = Any()

    /** True while the window must not be captured. */
    @Volatile
    var secure: Boolean = true
        private set

    private var pending: Decision? = null

    private data class Decision(val document: String, val allow: Boolean, val committed: Boolean = false)

    /** Secure, and drop any decision left from an older window. */
    fun start() {
        synchronized(lock) {
            secure = true
            pending = null
        }
        apply(true)
    }

    /**
     * A main-frame response arrived. Secure now, and replace the one pending
     * decision. Whether capture is allowed is decided here and applied only
     * from [onPageFinished].
     */
    fun onMainFrameResponse(url: String, headers: Map<String, String>?) {
        synchronized(lock) {
            secure = true
            pending = Decision(documentOf(url), allows(headers))
        }
        apply(true)
    }

    /**
     * Navigation started. Secure again and commit only a matching decision.
     * A different start leaves the decision pending but uncommitted.
     */
    fun onPageStarted(url: String) {
        synchronized(lock) {
            secure = true
            pending = pending?.let { it.copy(committed = it.document == documentOf(url)) }
        }
        apply(true)
    }

    /**
     * Apply a committed decision when it names this URL with the fragment
     * removed, then drop it. `allow` clears secure. Any other matching
     * decision keeps secure. No pending decision, an uncommitted decision,
     * or a decision for another document: no state change and no [apply] call.
     */
    fun onPageFinished(url: String) {
        val secureNow = synchronized(lock) {
            val decision = pending
            if (decision == null || !decision.committed || decision.document != documentOf(url)) return@synchronized null
            pending = null
            secure = !decision.allow
            secure
        } ?: return
        apply(secureNow)
    }

    /** The main frame failed. Secure, and forget a decision that will not paint. */
    fun onMainFrameError() {
        synchronized(lock) {
            secure = true
            pending = null
        }
        apply(true)
    }

    private fun allows(headers: Map<String, String>?): Boolean {
        if (headers.isNullOrEmpty()) return false
        var seen = false
        var allow = false
        for ((name, value) in headers) {
            if (!name.equals(HEADER, ignoreCase = true)) continue
            if (seen) return false
            seen = true
            allow = value.trim() == "allow"
        }
        return seen && allow
    }

    private fun documentOf(url: String): String {
        val cut = url.indexOf('#')
        return if (cut < 0) url else url.substring(0, cut)
    }

    private companion object {
        const val HEADER = "X-Levix-Screen-Capture"
    }
}
