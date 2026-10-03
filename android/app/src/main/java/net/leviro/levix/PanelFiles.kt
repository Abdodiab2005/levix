package net.leviro.levix

import java.util.Locale

/**
 * The rules the panel bridge applies to a file before it touches the disk or
 * the share sheet: a name a filesystem will accept, a MIME type on the
 * allowlist, and a narrow export route.
 *
 * Deliberately pure and dependency-free so the decisions are unit-tested
 * instead of only reachable through a WebView.
 */
object PanelFiles {
    fun validCallId(id: String): Boolean = id.matches(Regex("[A-Za-z0-9_-]{1,64}"))

    fun exportAllowed(path: String, method: String): Boolean {
        if (method != "GET" && method != "POST") return false
        if (!path.startsWith("/dashboard/api/stickers/") &&
            !path.startsWith("/dashboard/api/sticker-packs/")) return false
        return !path.contains("..") && !path.contains('\\') && !path.contains('#') &&
            !path.contains("//") && !path.any { it.code < 32 }
    }

    /**
     * The native multipart upload bridge may only POST these two panel
     * routes — the feedback form and scheduled messages. Everything else the
     * page sends must travel the WebView's own request path, so a compromised
     * page cannot turn the bridge into an arbitrary upload pipe.
     */
    fun uploadAllowed(path: String): Boolean =
        path == "/dashboard/api/feedback" || path == "/dashboard/api/schedules"

    /**
     * What Sticker Studio can hand back out of the panel: an exported sticker,
     * its PNG/GIF form, an MP4 preview, or a pack ZIP. Nothing else may leave
     * the app through the bridge — a share sheet that accepted
     * `application/octet-stream` would be a file dropper in disguise.
     */
    val SHARED_MIMES = setOf(
        "application/zip",
        "image/gif",
        "image/png",
        "image/webp",
        "video/mp4",
    )

    /** Null when the type is not on the allowlist. Parameters are ignored. */
    fun sharedMime(raw: String): String? {
        val mime = raw.trim().lowercase(Locale.ROOT).substringBefore(';').trim()
        return if (mime in SHARED_MIMES) mime else null
    }

    /**
     * A name safe to create in a cache folder or a Downloads collection:
     * separators, control characters and the punctuation Windows and FAT
     * reject become underscores, a leading dot or underscore can never hide the
     * file, and the length is capped.
     */
    fun sanitizeName(raw: String, fallback: String = "levix-file"): String {
        val cleaned = raw.trim()
            .replace(Regex("[\\\\/:*?\"<>|\u0000-\u001f]"), "_")
            .replace(Regex("_{2,}"), "_")
            .trim('.', '_', ' ')
            .take(120)
        return cleaned.ifBlank { fallback }
    }

    /**
     * Share copies in cacheDir/shared are dead weight the moment the share
     * sheet is done, and a host service can live for weeks. Anything older than
     * a day is swept before the next write.
     */
    const val SHARED_MAX_AGE_MS = 24L * 60 * 60 * 1000

    /** The FileProvider sub-folder the share sheet is pointed at. */
    const val SHARED_DIR = "shared"

}
