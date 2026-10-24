package net.leviro.levix.media

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.media.MediaMetadataRetriever
import android.util.LruCache
import android.util.Size
import androidx.core.content.edit
import androidx.core.net.toUri
import java.util.concurrent.ConcurrentHashMap

/**
 * Thumbnails and durations for the grid, always off the main thread.
 *
 * A documents provider answers `loadThumbnail` for MediaStore rows but usually
 * has nothing for a SAF video, so a video falls back to the first sync frame
 * of the file itself. The same retriever pass also reads the duration a SAF
 * row cannot carry, and both results are cached: frames in memory, durations
 * in memory and in `media_hub` prefs keyed by [MediaLogic.durationKey] so the
 * next scan does not reopen the file.
 */
class MediaThumbnails(context: Context, private val resolver: ContentResolver) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences("media_hub", Context.MODE_PRIVATE)

    private val frames = object : LruCache<String, Bitmap>(
        (Runtime.getRuntime().maxMemory() / 16).coerceAtMost(24L * 1024 * 1024).toInt(),
    ) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val durations = ConcurrentHashMap<String, Long>()

    data class Loaded(val thumbnail: Bitmap?, val durationMs: Long)

    fun thumbnail(id: String): Bitmap? = frames.get(id)

    /** A duration already measured for this id, or 0 while it is unknown. */
    fun duration(item: MediaItem): Long = when {
        item.duration > 0 -> item.duration
        else -> durations[item.id] ?: storedDuration(item)
    }

    fun load(item: MediaItem): Loaded {
        var durationMs = duration(item)
        var bitmap = frames.get(item.id)

        if (bitmap == null && item.mediaType in VISUAL) {
            bitmap = providerThumbnail(item.uri)
            if (bitmap == null && item.mediaType != MediaType.VIDEO) {
                bitmap = decodeImage(item.uri)
            }
        }

        val frameNeeded = bitmap == null && item.mediaType in VISUAL
        if (item.mediaType in MEASURED && (durationMs <= 0 || frameNeeded)) {
            val wanted = durationMs <= 0
            val facts = retriever(item.uri, frame = frameNeeded)
            if (wanted && facts.durationMs > 0) {
                durationMs = facts.durationMs
                remember(item, facts.durationMs)
            }
            if (bitmap == null && facts.frame != null) bitmap = facts.frame
        }

        if (bitmap != null) frames.put(item.id, bitmap)
        return Loaded(bitmap, durationMs)
    }

    private fun remember(item: MediaItem, durationMs: Long) {
        durations[item.id] = durationMs
        prefs.edit { putLong(prefKey(item), durationMs) }
    }

    private fun storedDuration(item: MediaItem): Long =
        prefs.getLong(prefKey(item), 0L).takeIf { it > 0 } ?: 0L

    private fun prefKey(item: MediaItem): String =
        "duration_${MediaLogic.durationKey(item).hashCode()}"

    private fun providerThumbnail(uri: String): Bitmap? = try {
        resolver.loadThumbnail(uri.toUri(), Size(SIZE, SIZE), null)
    } catch (_: Exception) {
        null
    }

    private fun decodeImage(uri: String): Bitmap? = try {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri.toUri())) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val width = info.size.width.coerceAtLeast(1)
            val height = info.size.height.coerceAtLeast(1)
            val scale = SIZE.toFloat() / maxOf(width, height).toFloat()
            if (scale < 1f) {
                decoder.setTargetSize(
                    (width * scale).toInt().coerceAtLeast(1),
                    (height * scale).toInt().coerceAtLeast(1),
                )
            }
        }
    } catch (_: Exception) {
        null
    }

    private data class Facts(val frame: Bitmap?, val durationMs: Long)

    /** One retriever pass: duration always, a sync frame only when asked for. */
    private fun retriever(uri: String, frame: Boolean): Facts {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(appContext, uri.toUri())
            val durationMs = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?.coerceAtLeast(0)
                ?: 0L
            val bitmap = if (frame) {
                try {
                    retriever.getScaledFrameAtTime(
                        0L,
                        MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
                        SIZE,
                        SIZE,
                    )
                } catch (_: Exception) {
                    null
                }
            } else {
                null
            }
            Facts(bitmap, durationMs)
        } catch (_: Exception) {
            Facts(null, 0)
        } finally {
            try {
                retriever.release()
            } catch (_: Exception) {
                // A retriever that never opened still has to be dropped.
            }
        }
    }

    private companion object {
        const val SIZE = 256
        val VISUAL = setOf(MediaType.IMAGE, MediaType.VIDEO, MediaType.STICKER)
        val MEASURED = setOf(MediaType.VIDEO, MediaType.VOICE, MediaType.AUDIO)
    }
}
