package net.leviro.levix.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.FileNotFoundException
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

class MediaLogicTest {
    private fun item(
        id: String,
        date: Long = 0,
        size: Long = 1,
        type: MediaType = MediaType.IMAGE,
        name: String = "$id.jpg",
        saved: Boolean = false,
        favorite: Boolean = false,
    ) = MediaItem(
        id = id,
        uri = "content://media/$id",
        displayName = name,
        mimeType = "image/jpeg",
        mediaType = type,
        size = size,
        dateAdded = date,
        dateModified = date,
        duration = 0,
        source = if (saved) MediaSource.LEVIX_SAVED else MediaSource.WHATSAPP,
        relativePath = "Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/",
        isStatus = false,
        isSaved = saved,
        isFavorite = favorite,
    )

    @Test
    fun sourcePaths() {
        assertEquals(
            MediaSource.WHATSAPP,
            MediaLogic.source("Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/Sent/"),
        )
        assertEquals(
            MediaSource.WHATSAPP_BUSINESS,
            MediaLogic.source("ANDROID/MEDIA/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Video/"),
        )
        assertEquals(MediaSource.WHATSAPP, MediaLogic.source("WhatsApp/Media/WhatsApp Audio/"))
        assertEquals(
            MediaSource.WHATSAPP_BUSINESS,
            MediaLogic.source("WhatsApp Business/Media/WhatsApp Business Documents/"),
        )
        assertNull(MediaLogic.source("DCIM/Camera/"))
    }

    @Test
    fun businessSentFoldersClassify() {
        val root = "Android/media/com.whatsapp.w4b/WhatsApp Business/Media/"
        assertEquals(MediaSource.WHATSAPP_BUSINESS, MediaLogic.source("${root}WhatsApp Business Images/Sent/"))
        assertEquals(MediaType.IMAGE, MediaLogic.type("${root}WhatsApp Business Images/Sent/", "image/jpeg"))
        assertEquals(MediaType.VIDEO, MediaLogic.type("${root}WhatsApp Business Video/Sent/", "video/mp4"))
        assertEquals(MediaType.VOICE, MediaLogic.type("${root}WhatsApp Business Voice Notes/Sent/", "audio/ogg"))
        assertEquals(MediaType.DOCUMENT, MediaLogic.type("${root}WhatsApp Business Documents/Sent/", "application/pdf"))
    }

    @Test
    fun typesAndStatuses() {
        assertEquals(MediaType.VOICE, MediaLogic.type("WhatsApp Voice Notes/", "audio/ogg"))
        assertEquals(MediaType.STICKER, MediaLogic.type("WhatsApp Stickers/", "image/webp"))
        assertEquals(MediaType.DOCUMENT, MediaLogic.type("WhatsApp Documents/", "application/pdf"))
        assertEquals(MediaType.VIDEO, MediaLogic.type("WhatsApp Animated Gifs/", "image/gif"))
        assertEquals(MediaType.AUDIO, MediaLogic.type("unknown/", "audio/mpeg"))
        assertEquals(MediaType.IMAGE, MediaLogic.type("unknown/", "image/jpeg"))
        assertTrue(MediaLogic.isStatus("WhatsApp/Media/.Statuses/"))
        assertFalse(MediaLogic.isStatus("WhatsApp/Media/Statuses backup/"))
    }

    @Test
    fun duplicateKeyIsStableAndDistinct() {
        val original = item("a", 100, 5, name = "ONE.JPG")
        assertEquals(
            MediaLogic.duplicateKey(original),
            MediaLogic.duplicateKey(original.copy(displayName = "one.jpg", id = "other")),
        )
        assertNotEquals(MediaLogic.duplicateKey(original), MediaLogic.duplicateKey(original.copy(size = 6)))
        assertNotEquals(
            MediaLogic.duplicateKey(original),
            MediaLogic.duplicateKey(original.copy(source = MediaSource.WHATSAPP_BUSINESS)),
        )
        assertFalse(MediaLogic.duplicateExists(original, emptyList(), false))
        assertTrue(MediaLogic.duplicateExists(original, emptyList(), true))
        assertTrue(MediaLogic.duplicateExists(
            original,
            listOf(original.copy(isSaved = true, source = MediaSource.LEVIX_SAVED)),
            false,
        ))
    }

    @Test
    fun sorts() {
        val input = listOf(item("a", 1, 30), item("b", 3, 10), item("c", 2, 20))
        fun ids(sort: MediaSort) = MediaLogic.visible(
            input, "Images", null, MediaFilter.ALL, sort, "", Instant.ofEpochSecond(4), ZoneId.of("UTC"),
        ).map { it.id }
        assertEquals(listOf("b", "c", "a"), ids(MediaSort.NEWEST))
        assertEquals(listOf("a", "c", "b"), ids(MediaSort.OLDEST))
        assertEquals(listOf("a", "c", "b"), ids(MediaSort.LARGEST))
        assertEquals(listOf("b", "c", "a"), ids(MediaSort.SMALLEST))
    }

    @Test
    fun calendarFiltersCrossMidnightAndZone() {
        val zone = ZoneId.of("Asia/Tokyo")
        val now = ZonedDateTime.of(2026, 10, 5, 0, 10, 0, 0, zone).toInstant()
        fun at(day: Int, hour: Int) = ZonedDateTime.of(2026, 10, day, hour, 0, 0, 0, zone).toEpochSecond()
        val input = listOf(
            item("today", at(5, 0)),
            item("yesterday", at(4, 23)),
            item("lastWeek", at(3, 23)),
        )
        fun ids(filter: MediaFilter) = MediaLogic.visible(
            input, "Images", null, filter, MediaSort.NEWEST, "", now, zone,
        ).map { it.id }
        assertEquals(listOf("today"), ids(MediaFilter.TODAY))
        assertEquals(listOf("yesterday"), ids(MediaFilter.YESTERDAY))
        assertEquals(listOf("today"), ids(MediaFilter.THIS_WEEK))
        assertEquals(3, ids(MediaFilter.ALL).size)
        assertEquals(
            listOf("today", "yesterday"),
            MediaLogic.visible(
                input, "Images", null, MediaFilter.TODAY, MediaSort.NEWEST, "", now, ZoneId.of("UTC"),
            ).map { it.id },
        )
    }

    @Test
    fun otherFiltersAndSearch() {
        val input = listOf(
            item("large", 1, 11L * 1024 * 1024, name = "Holiday.JPG"),
            item("saved", 2, 2, saved = true),
            item("fav", 3, 3, favorite = true),
        )
        fun ids(filter: MediaFilter, query: String = "") = MediaLogic.visible(
            input, "Images", null, filter, MediaSort.NEWEST, query,
            Instant.ofEpochSecond(4), ZoneId.of("UTC"),
        ).map { it.id }
        assertEquals(listOf("large"), ids(MediaFilter.LARGE))
        assertEquals(listOf("saved"), ids(MediaFilter.SAVED))
        assertEquals(listOf("fav"), ids(MediaFilter.FAVORITES))
        assertEquals(listOf("large"), ids(MediaFilter.ALL, "holiday"))
        assertEquals(3, ids(MediaFilter.ALL, "image").size)
        assertEquals(3, ids(MediaFilter.ALL, "1970-01-01").size)
    }

    @Test
    fun selectionLifecycleAndRescan() {
        val selection = SelectionState()
        selection.toggle("a")
        assertTrue(selection.active)
        selection.toggle("a")
        assertFalse(selection.active)
        selection.selectAll(listOf(item("a"), item("b")))
        assertEquals(2, selection.selected.size)
        selection.prune(listOf(item("b")))
        assertEquals(setOf("b"), selection.selected)
        selection.prune(emptyList())
        assertFalse(selection.active)
        selection.selectAll(listOf(item("c")))
        selection.clear()
        assertTrue(selection.selected.isEmpty())
    }

    @Test
    fun deleteCandidatesExcludeWhatsAppOwnedFiles() {
        val own = item("own", saved = true)
        val whatsapp = item("source")
        val incorrectlyFlagged = whatsapp.copy(id = "flagged", isSaved = true)
        assertEquals(listOf(own), MediaLogic.deleteCandidates(listOf(own, whatsapp, incorrectlyFlagged)))
    }

    @Test
    fun storageInsights() {
        val data = listOf(
            item("a", 1, 5),
            item("b", 2, 9, MediaType.VIDEO),
            item("c", 3, 100, saved = true),
        )
        val insight = MediaLogic.insights(data)
        assertEquals(14, insight.totalBytes)
        assertEquals(2, insight.count)
        assertEquals(5L, insight.byType[MediaType.IMAGE])
        assertEquals("b", insight.largest.first().id)
        assertEquals("b", insight.recent.first().id)
    }

    private fun row(id: Long, path: String, name: String, mime: String): MediaQuery.Row =
        object : MediaQuery.Row {
            override fun string(column: String): String? = when (column) {
                "relative_path" -> path
                "_display_name" -> name
                "mime_type" -> mime
                else -> null
            }

            override fun number(column: String): Long? = when (column) {
                "_id" -> id
                "_size" -> 100
                else -> 0
            }
        }

    @Test
    fun queryBuilderAndRowMapping() {
        assertEquals(4, MediaQuery.args.size)
        assertTrue(MediaQuery.selection.contains("relative_path"))
        val mapped = MediaQuery.map(
            row(42, "WhatsApp Business/Media/.Statuses/", "status.mp4", "video/mp4"),
            "content://media/42",
        )!!
        assertEquals("ms:42", mapped.id)
        assertEquals(MediaSource.WHATSAPP_BUSINESS, mapped.source)
        assertTrue(mapped.isStatus)
        assertEquals(MediaType.VIDEO, mapped.mediaType)
    }

    @Test
    fun stickerRowsFromImagesAndFilesHaveOneId() {
        val source = "WhatsApp/Media/WhatsApp Stickers/"
        val image = MediaQuery.map(row(81, source, "sticker.webp", "image/webp"), "content://images/81")!!
        val files = MediaQuery.map(row(81, source, "sticker.webp", "image/webp"), "content://files/81")!!
        val scanIndex = linkedMapOf(image.id to image)
        scanIndex[files.id] = files
        assertEquals("ms:81", image.id)
        assertEquals(image.id, files.id)
        assertEquals(1, scanIndex.size)
    }

    @Test
    fun documentMappingSkipsHiddenFilesAndConvertsDates() {
        val statusPath = "primary:Android/media/com.whatsapp/WhatsApp/Media/.Statuses"
        val documentsPath = "primary:Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Documents"
        fun map(name: String, mime: String, parent: String) = MediaQuery.mapDocument(
            "doc-1", name, mime, 123, 1_700_000_000_000L,
            parent, MediaSource.WHATSAPP, "content://tree/doc-1",
        )
        assertNull(map(".nomedia", "application/octet-stream", statusPath))
        assertNull(map(".hidden.jpg", "image/jpeg", statusPath))
        val status = map("status.jpg", "image/jpeg", statusPath)!!
        assertTrue(status.isStatus)
        assertEquals(MediaType.IMAGE, status.mediaType)
        assertEquals(1_700_000_000L, status.dateAdded)
        assertEquals(status.dateAdded, status.dateModified)
        val document = map("report.pdf", "application/pdf", documentsPath)!!
        assertFalse(document.isStatus)
        assertEquals(MediaType.DOCUMENT, document.mediaType)
        assertEquals(1_700_000_000L, document.dateAdded)
        assertNull(map("other.jpg", "image/jpeg", "WhatsApp/Media/WhatsApp Images"))
    }

    @Test
    fun revokedAndMissingMedia() {
        assertFalse(validGrant("content://tree", object : PermissionSource {
            override fun has(uri: String) = false
        }))
        assertTrue(validGrant("content://tree", object : PermissionSource {
            override fun has(uri: String) = true
        }))
        assertFalse(mediaAvailable(object : ReadableMedia {
            override fun open(uri: String): java.io.InputStream? = throw FileNotFoundException()
        }, "gone"))
    }
}
