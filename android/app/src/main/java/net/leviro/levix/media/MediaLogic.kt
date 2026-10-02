package net.leviro.levix.media

import java.time.Instant
import java.time.ZoneId
import java.util.Locale

enum class MediaType { IMAGE, VIDEO, VOICE, AUDIO, DOCUMENT, STICKER }
enum class MediaSource { WHATSAPP, WHATSAPP_BUSINESS, LEVIX_SAVED }
enum class MediaFilter { ALL, TODAY, YESTERDAY, THIS_WEEK, LARGE, SAVED, FAVORITES }
enum class MediaSort { NEWEST, OLDEST, LARGEST, SMALLEST }

data class MediaItem(
    val id: String,
    val uri: String,
    val displayName: String,
    val mimeType: String,
    val mediaType: MediaType,
    val size: Long,
    val dateAdded: Long,
    val dateModified: Long,
    val duration: Long,
    val source: MediaSource,
    val relativePath: String,
    val isStatus: Boolean,
    val isSaved: Boolean = false,
    val isFavorite: Boolean = false,
)

/** Paths are MediaStore relative paths or SAF document IDs, never raw file paths. */
object MediaLogic {
    fun source(path: String): MediaSource? {
        val normalized = path.lowercase(Locale.ROOT).replace('\\', '/')
        if (normalized.contains("levix/whatsapp")) return MediaSource.LEVIX_SAVED

        val business = normalized.contains("com.whatsapp.w4b") ||
            normalized.contains("whatsapp business")
        val regular = normalized.contains("com.whatsapp/") ||
            normalized.contains("whatsapp/media/")
        return when {
            business && normalized.contains("/media/") -> MediaSource.WHATSAPP_BUSINESS
            regular && normalized.contains("/media/") -> MediaSource.WHATSAPP
            else -> null
        }
    }

    fun isStatus(path: String): Boolean = path.lowercase(Locale.ROOT)
        .replace('\\', '/')
        .split('/')
        .any { it == ".statuses" }

    /**
     * What Sticker Studio can be asked to do with an item, or NONE when the
     * item has no business becoming a sticker.
     *
     * A WhatsApp sticker is already a WebP that fits the canvas, so it is only
     * added to the library. Anything else that is a picture or a clip is
     * opened in the converter, which frames and re-encodes it. Voice notes,
     * audio and documents have no sticker form at all, and an image whose size
     * the store did not report cannot be checked against the 16 MB upload cap
     * up front, so it is refused rather than handed over.
     */
    fun stickerIntent(item: MediaItem): StickerIntent {
        if (item.size <= 0 || item.size > PendingStickers.MAX_BYTES) return StickerIntent.NONE
        return when (item.mediaType) {
            MediaType.STICKER -> StickerIntent.SAVE
            MediaType.IMAGE, MediaType.VIDEO -> StickerIntent.CREATE
            MediaType.VOICE, MediaType.AUDIO, MediaType.DOCUMENT -> StickerIntent.NONE
        }
    }

    /** True when the item can be offered as a sticker at all. */
    fun stickerable(item: MediaItem): Boolean = stickerIntent(item) != StickerIntent.NONE

    fun type(path: String, mime: String): MediaType {
        val normalized = path.lowercase(Locale.ROOT)
        return when {
            "sticker" in normalized -> MediaType.STICKER
            "voice notes" in normalized || "voice note" in normalized -> MediaType.VOICE
            "document" in normalized -> MediaType.DOCUMENT
            "animated gifs" in normalized -> MediaType.VIDEO
            "video" in normalized -> MediaType.VIDEO
            "audio" in normalized -> MediaType.AUDIO
            "image" in normalized || isStatus(path) && mime.startsWith("image/") -> MediaType.IMAGE
            mime.startsWith("video/") -> MediaType.VIDEO
            mime.startsWith("audio/") -> MediaType.AUDIO
            mime.startsWith("image/") -> MediaType.IMAGE
            else -> MediaType.DOCUMENT
        }
    }

    fun duplicateKey(item: MediaItem): String = listOf(
        item.source.name,
        item.displayName.lowercase(Locale.ROOT),
        item.size,
        item.dateModified.takeIf { it > 0 } ?: 0,
    ).joinToString("|")

    fun duplicateExists(
        item: MediaItem,
        library: List<MediaItem>,
        indexedCopyExists: Boolean,
    ): Boolean = item.isSaved || indexedCopyExists || library.any {
        it.isSaved && it.displayName.equals(item.displayName, true) && it.size == item.size
    }

    fun deleteCandidates(items: List<MediaItem>): List<MediaItem> = items.filter {
        it.isSaved && it.source == MediaSource.LEVIX_SAVED
    }

    fun visible(
        items: List<MediaItem>,
        category: String,
        source: MediaSource?,
        filter: MediaFilter,
        sort: MediaSort,
        search: String,
        now: Instant,
        zone: ZoneId,
    ): List<MediaItem> {
        val today = now.atZone(zone).toLocalDate()
        val weekStart = today.minusDays((today.dayOfWeek.value - 1).toLong())
        val query = search.trim().lowercase(Locale.ROOT)

        return items.asSequence()
            .filter { source == null || it.source == source || category == "Saved" && it.isSaved }
            .filter { item ->
                when (category) {
                    "Statuses" -> item.isStatus
                    "Images" -> item.mediaType == MediaType.IMAGE && !item.isStatus
                    "Videos" -> item.mediaType == MediaType.VIDEO && !item.isStatus
                    "Voice notes" -> item.mediaType == MediaType.VOICE
                    "Audio" -> item.mediaType == MediaType.AUDIO
                    "Documents" -> item.mediaType == MediaType.DOCUMENT
                    "Stickers" -> item.mediaType == MediaType.STICKER
                    "Saved" -> item.isSaved
                    else -> true
                }
            }
            .filter { item ->
                val seconds = item.dateModified.takeIf { it > 0 } ?: item.dateAdded
                val day = Instant.ofEpochSecond(seconds).atZone(zone).toLocalDate()
                when (filter) {
                    MediaFilter.ALL -> true
                    MediaFilter.TODAY -> day == today
                    MediaFilter.YESTERDAY -> day == today.minusDays(1)
                    MediaFilter.THIS_WEEK -> !day.isBefore(weekStart) && !day.isAfter(today)
                    MediaFilter.LARGE -> item.size >= 10L * 1024 * 1024
                    MediaFilter.SAVED -> item.isSaved
                    MediaFilter.FAVORITES -> item.isFavorite
                }
            }
            .filter { item ->
                if (query.isEmpty()) return@filter true
                val seconds = item.dateModified.takeIf { it > 0 } ?: item.dateAdded
                val date = Instant.ofEpochSecond(seconds).atZone(zone).toLocalDate().toString()
                item.displayName.lowercase(Locale.ROOT).contains(query) ||
                    item.mediaType.name.lowercase(Locale.ROOT).contains(query) ||
                    date.contains(query)
            }
            .sortedWith(
                when (sort) {
                    MediaSort.NEWEST -> compareByDescending<MediaItem> {
                        it.dateModified.takeIf { date -> date > 0 } ?: it.dateAdded
                    }.thenBy { it.id }
                    MediaSort.OLDEST -> compareBy<MediaItem> {
                        it.dateModified.takeIf { date -> date > 0 } ?: it.dateAdded
                    }.thenBy { it.id }
                    MediaSort.LARGEST -> compareByDescending<MediaItem> { it.size }.thenBy { it.id }
                    MediaSort.SMALLEST -> compareBy<MediaItem> { it.size }.thenBy { it.id }
                },
            )
            .toList()
    }

    data class Insights(
        val totalBytes: Long,
        val count: Int,
        val byType: Map<MediaType, Long>,
        val largest: List<MediaItem>,
        val recent: List<MediaItem>,
    )

    fun insights(items: List<MediaItem>): Insights {
        val original = items.filter { !it.isSaved }
        return Insights(
            totalBytes = original.sumOf { it.size.coerceAtLeast(0) },
            count = original.size,
            byType = original.groupBy { it.mediaType }
                .mapValues { (_, group) -> group.sumOf { it.size.coerceAtLeast(0) } },
            largest = original.sortedByDescending { it.size }.take(5),
            recent = original.sortedByDescending { it.dateAdded }.take(5),
        )
    }
}

class SelectionState {
    private val ids = linkedSetOf<String>()

    val selected: Set<String> get() = ids.toSet()
    val active: Boolean get() = ids.isNotEmpty()

    fun toggle(id: String) {
        if (!ids.add(id)) ids.remove(id)
    }

    fun selectAll(items: List<MediaItem>) {
        ids.addAll(items.map { it.id })
    }

    fun clear() {
        ids.clear()
    }

    fun prune(items: List<MediaItem>) {
        ids.retainAll(items.mapTo(hashSetOf()) { it.id })
    }
}
