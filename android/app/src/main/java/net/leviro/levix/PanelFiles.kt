package net.leviro.levix

import java.util.Locale

/**
 * The rules the panel bridge applies to a file before it touches the disk or
 * the share sheet: a name a filesystem will accept, a MIME type on the
 * allowlist, and a size the JS bridge can carry.
 *
 * Deliberately pure and dependency-free so the decisions are unit-tested
 * instead of only reachable through a WebView.
 */
object PanelFiles {
    /** See PendingStickers.MAX_BYTES: base64 across one synchronous bridge call. */
    const val MAX_BRIDGE_BYTES = 16L * 1024 * 1024

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

    /** A size the bridge will carry, once decoded. */
    fun fitsBridgeCap(size: Long): Boolean = size in 1..MAX_BRIDGE_BYTES

    /**
     * Share copies in cacheDir/shared are dead weight the moment the share
     * sheet is done, and a host service can live for weeks. Anything older than
     * a day is swept before the next write.
     */
    const val SHARED_MAX_AGE_MS = 24L * 60 * 60 * 1000

    /** The FileProvider sub-folder the share sheet is pointed at. */
    const val SHARED_DIR = "shared"

    /**
     * The same cap before decoding: 4 base64 characters per 3 bytes, plus
     * slack for padding and any line breaks the page wrapped. Checking first
     * is what stops a stray 100 MB string from being turned into a 75 MB array
     * first and refused afterwards.
     */
    fun encodedFitsCap(encoded: String): Boolean =
        encoded.length <= MAX_BRIDGE_BYTES / 3 * 4 + 1024
}