package net.leviro.levix.media

import android.app.PendingIntent
import android.app.RecoverableSecurityException
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.MediaStore
import androidx.core.content.edit
import androidx.core.net.toUri
import java.io.FileNotFoundException
import java.io.IOException

/** Query construction and row mapping are exercised with fake rows in local JVM tests. */
object MediaQuery {
    val roots = listOf(
        "Android/media/com.whatsapp/WhatsApp/Media/",
        "Android/media/com.whatsapp.w4b/WhatsApp Business/Media/",
        "WhatsApp/Media/",
        "WhatsApp Business/Media/",
    )
    val selection = roots.joinToString(" OR ", "(", ")") {
        "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?"
    }
    val args = roots.map { "$it%" }.toTypedArray()
    val projection = arrayOf(
        MediaStore.MediaColumns._ID,
        MediaStore.MediaColumns.DISPLAY_NAME,
        MediaStore.MediaColumns.MIME_TYPE,
        MediaStore.MediaColumns.SIZE,
        MediaStore.MediaColumns.DATE_ADDED,
        MediaStore.MediaColumns.DATE_MODIFIED,
        MediaStore.MediaColumns.RELATIVE_PATH,
    )

    interface Row {
        fun string(column: String): String?
        fun number(column: String): Long?
    }

    fun map(row: Row, uri: String): MediaItem? {
        val id = row.number(MediaStore.MediaColumns._ID) ?: return null
        val path = row.string(MediaStore.MediaColumns.RELATIVE_PATH) ?: return null
        val source = MediaLogic.source(path) ?: return null
        val mime = row.string(MediaStore.MediaColumns.MIME_TYPE).orEmpty()
        return MediaItem(
            id = "ms:$id",
            uri = uri,
            displayName = row.string(MediaStore.MediaColumns.DISPLAY_NAME).orEmpty(),
            mimeType = mime,
            mediaType = MediaLogic.type(path, mime),
            size = row.number(MediaStore.MediaColumns.SIZE) ?: 0,
            dateAdded = row.number(MediaStore.MediaColumns.DATE_ADDED) ?: 0,
            dateModified = row.number(MediaStore.MediaColumns.DATE_MODIFIED) ?: 0,
            duration = row.number(MediaStore.MediaColumns.DURATION) ?: 0,
            source = source,
            relativePath = path,
            isStatus = MediaLogic.isStatus(path),
            isSaved = source == MediaSource.LEVIX_SAVED,
        )
    }

    fun mapDocument(
        id: String,
        name: String,
        mime: String,
        size: Long,
        lastModifiedMs: Long,
        parentPath: String,
        source: MediaSource,
        uri: String,
    ): MediaItem? {
        if (name.startsWith(".")) return null
        if (!MediaLogic.isStatus(parentPath) && !parentPath.contains("Documents", true)) return null

        val path = "$parentPath/$name"
        val modifiedSeconds = lastModifiedMs / 1000
        return MediaItem(
            id = "saf:$id",
            uri = uri,
            displayName = name,
            mimeType = mime,
            mediaType = MediaLogic.type(path, mime),
            size = size,
            dateAdded = modifiedSeconds,
            dateModified = modifiedSeconds,
            duration = 0,
            source = source,
            relativePath = path,
            isStatus = MediaLogic.isStatus(path),
        )
    }
}

interface PermissionSource {
    fun has(uri: String): Boolean
}

fun validGrant(stored: String?, permissions: PermissionSource): Boolean =
    stored != null && permissions.has(stored)

interface ReadableMedia {
    @Throws(FileNotFoundException::class)
    fun open(uri: String): java.io.InputStream?
}

fun mediaAvailable(reader: ReadableMedia, uri: String): Boolean = try {
    reader.open(uri)?.use { true } ?: false
} catch (_: FileNotFoundException) {
    false
} catch (_: SecurityException) {
    false
} catch (_: IllegalArgumentException) {
    false
}

class MediaRepository(context: Context) {
    private val resolver = context.contentResolver
    private val prefs = context.getSharedPreferences("media_hub", Context.MODE_PRIVATE)
    private val favoriteIds get() = prefs.getStringSet("favorites", emptySet()).orEmpty()
    private val savedKeys get() = prefs.getStringSet("saved_keys", emptySet()).orEmpty()

    @Volatile
    var brokenTrees: Set<MediaSource> = emptySet()
        private set

    val observedUris: List<Uri> = listOf(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
        MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
        MediaStore.Files.getContentUri("external"),
    )

    fun favorites(): Set<String> = favoriteIds.toSet()

    fun toggleFavorite(id: String) {
        val next = favoriteIds.toMutableSet()
        if (!next.add(id)) next.remove(id)
        prefs.edit { putStringSet("favorites", next) }
    }

    fun savedTree(source: MediaSource): Uri? {
        val raw = prefs.getString("tree_${source.name}", null) ?: return null
        val allowed = validGrant(raw, object : PermissionSource {
            override fun has(uri: String): Boolean = resolver.persistedUriPermissions.any {
                it.uri.toString() == uri && it.isReadPermission
            }
        })
        if (!allowed) return null
        return try {
            raw.toUri()
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    fun hadTree(source: MediaSource) = prefs.contains("tree_${source.name}")

    fun rememberTree(source: MediaSource, tree: Uri) {
        prefs.edit { putString("tree_${source.name}", tree.toString()) }
    }

    fun scan(): List<MediaItem> {
        val result = linkedMapOf<String, MediaItem>()
        val collections = listOf(
            "image" to MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            "video" to MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
            "audio" to MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
            "files" to MediaStore.Files.getContentUri("external"),
        )
        for ((name, collection) in collections) {
            queryPaged(collection, name, MediaQuery.selection, MediaQuery.args) { item ->
                if (name != "files" || item.mediaType == MediaType.DOCUMENT) {
                    result[item.id] = item
                }
            }
        }

        // App-owned copies remain visible with selected-media access.
        val savedCollections = listOf(
            Triple("image", MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "Pictures/Levix/WhatsApp/"),
            Triple("video", MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "Movies/Levix/WhatsApp/"),
            Triple("audio", MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, "Music/Levix/WhatsApp/"),
            Triple("files", MediaStore.Downloads.EXTERNAL_CONTENT_URI, "Download/Levix/WhatsApp/"),
        )
        for ((name, collection, path) in savedCollections) {
            queryPaged(
                collection,
                name,
                "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?",
                arrayOf("$path%"),
            ) { item ->
                result[item.id] = item.copy(source = MediaSource.LEVIX_SAVED, isSaved = true)
            }
        }

        val broken = mutableSetOf<MediaSource>()
        for (source in listOf(MediaSource.WHATSAPP, MediaSource.WHATSAPP_BUSINESS)) {
            val tree = savedTree(source)
            if (tree == null) {
                if (hadTree(source)) broken.add(source)
                continue
            }
            try {
                scanTree(tree, source).forEach { saf ->
                    val alreadyIndexed = result.values.any {
                        it.source == saf.source && it.displayName == saf.displayName &&
                            it.size == saf.size && it.isStatus == saf.isStatus
                    }
                    if (!alreadyIndexed) result[saf.id] = saf
                }
            } catch (_: Exception) {
                broken.add(source)
            }
        }
        brokenTrees = broken
        return result.values.map { it.copy(isFavorite = favoriteIds.contains(it.id)) }
    }

    private fun queryPaged(
        uri: Uri,
        collection: String,
        selection: String,
        args: Array<String>,
        add: (MediaItem) -> Unit,
    ) {
        var offset = 0
        val page = 250
        val columns = if (collection == "video" || collection == "audio") {
            MediaQuery.projection + MediaStore.MediaColumns.DURATION
        } else {
            MediaQuery.projection
        }
        var previousFirstId = -1L
        while (offset < 250_000) {
            val cursor = try {
                if (Build.VERSION.SDK_INT >= 30) {
                    resolver.query(uri, columns, Bundle().apply {
                        putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
                        putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args)
                        putString(
                            ContentResolver.QUERY_ARG_SQL_SORT_ORDER,
                            "${MediaStore.MediaColumns.DATE_MODIFIED} DESC",
                        )
                        putInt(ContentResolver.QUERY_ARG_LIMIT, page)
                        putInt(ContentResolver.QUERY_ARG_OFFSET, offset)
                    }, null)
                } else {
                    resolver.query(
                        uri, columns, selection, args,
                        "${MediaStore.MediaColumns.DATE_MODIFIED} DESC LIMIT $page OFFSET $offset",
                    )
                }
            } catch (_: Exception) {
                null
            } ?: break

            val count = cursor.use { rows ->
                if (rows.moveToFirst()) {
                    val firstId = rows.getLong(rows.getColumnIndexOrThrow(MediaStore.MediaColumns._ID))
                    if (firstId == previousFirstId) return
                    previousFirstId = firstId
                    rows.moveToPosition(-1)
                }
                while (rows.moveToNext()) {
                    try {
                        val id = rows.getLong(rows.getColumnIndexOrThrow(MediaStore.MediaColumns._ID))
                        val item = MediaQuery.map(object : MediaQuery.Row {
                            override fun string(column: String): String? = rows.getColumnIndex(column)
                                .takeIf { it >= 0 }?.let(rows::getString)

                            override fun number(column: String): Long? = rows.getColumnIndex(column)
                                .takeIf { it >= 0 }?.let(rows::getLong)
                        }, ContentUris.withAppendedId(uri, id).toString())
                        if (item != null) add(item)
                    } catch (_: Exception) {
                        // A malformed row should not hide the rest of the page.
                    }
                }
                rows.count
            }
            offset += count
            if (count < page) break
        }
    }

    private fun scanTree(tree: Uri, source: MediaSource): List<MediaItem> {
        val result = mutableListOf<MediaItem>()
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val root = DocumentsContract.buildDocumentUriUsingTree(tree, rootId)
        val rootExists = resolver.query(
            root,
            arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID),
            null, null, null,
        )?.use { it.moveToFirst() } == true
        if (!rootExists) throw FileNotFoundException()

        val folders = ArrayDeque<Pair<Uri, String>>()
        folders.add(root to rootId)
        var visited = 0
        while (folders.isNotEmpty() && visited < 100_000) {
            val (parent, path) = folders.removeFirst()
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(
                tree,
                DocumentsContract.getDocumentId(parent),
            )
            val cursor = try {
                resolver.query(children, arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                ), null, null, null)
            } catch (_: Exception) {
                null
            } ?: continue

            cursor.use { rows ->
                while (rows.moveToNext() && visited++ < 100_000) {
                    try {
                        val id = rows.getString(0)
                        val name = rows.getString(1).orEmpty()
                        val mime = rows.getString(2).orEmpty()
                        val document = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                            val relevant = name.equals(".Statuses", true) ||
                                name.contains("Documents", true) || path.contains(".Statuses", true)
                            if (relevant) folders.add(document to "$path/$name")
                        } else {
                            MediaQuery.mapDocument(
                                id = id,
                                name = name,
                                mime = mime,
                                size = if (rows.isNull(3)) 0 else rows.getLong(3),
                                lastModifiedMs = if (rows.isNull(4)) 0 else rows.getLong(4),
                                parentPath = path,
                                source = source,
                                uri = document.toString(),
                            )?.let(result::add)
                        }
                    } catch (_: Exception) {
                        // A file can vanish between the directory query and mapping.
                    }
                }
            }
        }
        return result
    }

    enum class SaveResult { SAVED, ALREADY_SAVED, FAILED }

    fun save(item: MediaItem, all: List<MediaItem>): SaveResult {
        val key = MediaLogic.duplicateKey(item)
        val prior = prefs.getString("saved_uri_${key.hashCode()}", null)
        val exists = savedKeys.contains(key) && prior != null && try {
            resolver.query(prior.toUri(), arrayOf(MediaStore.MediaColumns._ID), null, null, null)
                ?.use { it.moveToFirst() } == true
        } catch (_: Exception) {
            false
        }
        if (MediaLogic.duplicateExists(item, all, exists)) return SaveResult.ALREADY_SAVED

        val (collection, path) = when (item.mediaType) {
            MediaType.IMAGE, MediaType.STICKER ->
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI to "Pictures/Levix/WhatsApp/"
            MediaType.VIDEO ->
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI to "Movies/Levix/WhatsApp/"
            MediaType.VOICE, MediaType.AUDIO ->
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI to "Music/Levix/WhatsApp/"
            MediaType.DOCUMENT ->
                MediaStore.Downloads.EXTERNAL_CONTENT_URI to "Download/Levix/WhatsApp/"
        }
        var target: Uri? = null
        return try {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, item.displayName)
                put(MediaStore.MediaColumns.MIME_TYPE, item.mimeType.ifBlank { "application/octet-stream" })
                put(MediaStore.MediaColumns.RELATIVE_PATH, path)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            target = resolver.insert(collection, values) ?: return SaveResult.FAILED
            resolver.openInputStream(item.uri.toUri()).use { input ->
                if (input == null) throw FileNotFoundException()
                resolver.openOutputStream(target!!).use { output ->
                    if (output == null) throw IOException()
                    input.copyTo(output)
                }
            }
            resolver.update(
                target!!,
                ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
                null,
                null,
            )
            prefs.edit {
                putStringSet("saved_keys", savedKeys + key)
                putString("saved_uri_${key.hashCode()}", target.toString())
            }
            SaveResult.SAVED
        } catch (_: Exception) {
            target?.let {
                try {
                    resolver.delete(it, null, null)
                } catch (_: Exception) {
                    // The pending row may already have disappeared.
                }
            }
            SaveResult.FAILED
        }
    }

    data class DeleteOutcome(
        val success: Boolean,
        val needsConsent: Boolean = false,
        val consent: PendingIntent? = null,
    )

    fun deleteSaved(items: List<MediaItem>): DeleteOutcome {
        var all = true
        for (item in MediaLogic.deleteCandidates(items)) {
            try {
                if (resolver.delete(item.uri.toUri(), null, null) <= 0) all = false
            } catch (error: RecoverableSecurityException) {
                return DeleteOutcome(false, true, error.userAction.actionIntent)
            } catch (_: SecurityException) {
                return DeleteOutcome(false, true)
            } catch (_: Exception) {
                all = false
            }
        }
        return DeleteOutcome(all)
    }
}
