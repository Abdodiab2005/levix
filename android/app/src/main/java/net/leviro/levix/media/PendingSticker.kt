package net.leviro.levix.media

/**
 * What Sticker Studio is asked to do with the file it is handed.
 *
 * An enum rather than a boolean pair because the decision is made once, in
 * MediaLogic, and read in two places: the label the user is shown and the
 * instruction the panel is given. They can never disagree that way.
 */
enum class StickerIntent {
    /** Open the converter: the file needs trimming, framing and re-encoding. */
    CREATE,

    /** Keep the file as it is and only put it in the library (a .webp sticker). */
    SAVE,

    /**
     * The item has no sticker form at all — a voice note, an audio file, a
     * document, or something whose size the store never reported, so it cannot
     * be checked against the upload cap. Nothing is offered and nothing is
     * handed over.
     */
    NONE,
}

/**
 * The single file the Media Hub hands over to Sticker Studio: a URI it already
 * has permission to read, the display name to show, and what the panel should
 * do with it.
 */
data class PendingSticker(
    val uri: String,
    val mime: String,
    val name: String,
    val intent: StickerIntent,
)

/**
 * Process-wide parking space for one file, between the native screen that
 * picked it and the panel WebView that reads it through
 * `LevixHost.takePendingSticker()`.
 *
 * In-memory on purpose. It is a reference to a file Levix can already read, it
 * is meant to survive exactly one panel visit, and nothing about a user's photo
 * should outlive the process. Reading it is one-shot: a file that fails to load
 * is not retried by a later page, so it can never be converted twice.
 */
object PendingStickers {
    /**
     * Media Hub's offer rule mirrors the server upload ceiling in
     * src/stickers/limits.cjs (UPLOAD_MAX_BYTES).
     */
    const val MAX_BYTES = 16L * 1024 * 1024

    @Volatile
    private var pending: PendingSticker? = null

    fun set(item: PendingSticker) {
        pending = item
    }

    fun peek(): PendingSticker? = pending

    /** One-shot: the holder is cleared even when the caller goes on to fail. */
    fun take(): PendingSticker? {
        val taken = pending
        pending = null
        return taken
    }

    fun clear() {
        pending = null
    }
}

/**
 * Why a pick could not be handed to Sticker Studio, so the screen says
 * something specific instead of a generic failure.
 */
enum class StickerHandoff {
    /** Parked; open the panel on Sticker Studio. */
    READY,

    /** Bigger than the bridge carries and than the server accepts. */
    TOO_LARGE,

    /** The store never reported a size, so the cap cannot be checked. */
    SIZE_UNKNOWN,

    /** Not a picture or a clip: a voice note, an audio file, a document. */
    UNSUPPORTED,
}

/**
 * The single decision path from "the user tapped the sticker action" to "the
 * panel has a file to pick up".
 *
 * Both entry points (the selection bar and the viewer) go through it, so the
 * size gate, the one-shot handoff and the failure messages cannot drift apart.
 * It never touches bytes: only PendingStickers.set() runs, and the read happens
 * on the WebView's JavaBridge thread when the panel asks for it.
 */
object StickerHandoffs {
    /** The client route hash the panel's Sticker Studio screen lives at. */
    const val PANEL_HASH = "stickers"

    /**
     * Checks the item, parks it and returns what the screen should do. The
     * decision is made from MediaStore's own metadata — an item whose size was
     * never reported is refused rather than discovered to be 200 MB later.
     */
    fun prepare(item: MediaItem): StickerHandoff {
        val intent = MediaLogic.stickerIntent(item)
        if (intent != StickerIntent.NONE) {
            PendingStickers.set(
                PendingSticker(
                    uri = item.uri,
                    mime = item.mimeType,
                    name = item.displayName,
                    intent = intent,
                ),
            )
            return StickerHandoff.READY
        }
        return when {
            item.size <= 0 -> StickerHandoff.SIZE_UNKNOWN
            item.size > PendingStickers.MAX_BYTES -> StickerHandoff.TOO_LARGE
            else -> StickerHandoff.UNSUPPORTED
        }
    }
}
