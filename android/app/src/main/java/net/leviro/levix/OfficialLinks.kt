package net.leviro.levix

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.net.URI

/**
 * The only destinations the panel may hand to another app. Every link is a
 * fixed HTTPS URL, plus a GitHub release tag that must carry a strict semantic
 * version, so a page cannot turn the host into a generic URL opener.
 *
 * Validation is exact matching (fixed set or the release-tag pattern) with a
 * URI parse as a second, independent refusal for credentials, ports,
 * fragments, encoded tricks and lookalike authorities. Nothing here may open
 * inside the WebView: [open] always leaves with an ordinary ACTION_VIEW.
 */
object OfficialLinks {
    const val WEBSITE = "https://levix.leviro.net"
    const val DOCS = "https://levix.leviro.net/docs"
    const val SUPPORT = "https://levix.leviro.net/feedback"
    const val STUDIO = "https://leviro.net"
    const val PORTFOLIO = "https://abdelrhman.leviro.net"
    const val GITHUB = "https://github.com/Abdodiab2005/levix"
    const val RELEASES = "https://github.com/Abdodiab2005/levix/releases"
    const val PLAY = "https://play.google.com/store/apps/details?id=net.leviro.levix"

    private const val MAX_URL_CHARS = 512
    private const val RELEASE_PREFIX =
        "https://github.com/Abdodiab2005/levix/releases/tag/"

    // Semantic Versioning 2.0.0, including prerelease and build metadata.
    // Numeric identifiers may not carry leading zeros; build identifiers may.
    private const val SEMVER =
        "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)" +
            "(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)" +
            "(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?" +
            "(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?"

    private val FIXED = setOf(WEBSITE, DOCS, SUPPORT, STUDIO, PORTFOLIO, GITHUB, RELEASES, PLAY)
    private val RELEASE_TAG = Regex("^${Regex.escape(RELEASE_PREFIX)}v?$SEMVER")

    /** The URL when it is one of the allowed destinations, otherwise null. */
    fun validate(raw: String): String? {
        if (raw.isEmpty() || raw.length > MAX_URL_CHARS) return null
        // Exact strings only: no surrounding space, no line break, no control
        // character, no backslash a parser might read differently.
        if (raw != raw.trim()) return null
        if (raw.any { it.code < 0x21 || it.code == 0x7f || it == '\\' }) return null
        if ('%' in raw) return null

        val uri = try {
            URI(raw)
        } catch (_: Exception) {
            return null
        }
        if (!strictHttps(uri)) return null

        if (raw in FIXED) return raw

        if (!RELEASE_TAG.matches(raw)) return null
        if (uri.host != "github.com" || uri.rawQuery != null) return null
        return raw
    }

    fun isOfficial(raw: String): Boolean = validate(raw) != null

    /**
     * Opens a validated official destination in whichever app handles HTTPS.
     * The caller stays in the WebView; an absent handler is a refusal, never a
     * fallback to loading the page here.
     */
    fun open(context: Context, raw: String): Boolean {
        val safe = validate(raw) ?: return false
        return try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(safe))
                .addCategory(Intent.CATEGORY_BROWSABLE)
            if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        } catch (error: Exception) {
            HostLog.event("official link unavailable ${error.javaClass.simpleName}")
            false
        }
    }

    private fun strictHttps(uri: URI): Boolean =
        uri.scheme == "https" &&
            uri.userInfo == null &&
            uri.port == -1 &&
            uri.rawFragment == null &&
            // A raw authority that is not exactly the host carries credentials,
            // a port or an encoded lookalike that URI decoded differently.
            uri.rawAuthority == uri.host &&
            uri.host != null
}
