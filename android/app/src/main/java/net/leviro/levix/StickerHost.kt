package net.leviro.levix

import android.content.ContentValues
import android.content.Context
import android.net.LocalSocket
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.DocumentsContract
import androidx.core.net.toUri
import net.leviro.levix.media.PendingStickers
import net.leviro.levix.media.StickerIntent
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Activity-owned native sticker transfers. Only small result JSON enters the WebView. */
class StickerHost(
    private val context: Context,
    private val sock: File,
    val sources: StickerSources,
    private val deliver: (String, JSONObject) -> Unit,
    private val launchPicker: (String, Boolean) -> Unit,
    private val share: (File, String) -> Unit,
    private val launchBackupSave: (String, String) -> Unit,
    private val progress: (String, Long, Long) -> Unit,
) {
    private class Transfer(val document: PendingDocument? = null) {
        val finished = AtomicBoolean(false)
        @Volatile var socket: LocalSocket? = null
        @Volatile var source: InputStream? = null
        @Volatile var output: OutputStream? = null
        @Volatile var cancelled = false
        var started = false // guarded by this Transfer
        fun stop() {
            cancelled = true
            runCatching { socket?.close() }
            runCatching { source?.close() }
            runCatching { output?.close() }
        }
    }
    private val executor = Executors.newSingleThreadExecutor()
    private val transfers = ConcurrentHashMap<String, Transfer>()
    private val pendingSaves = ConcurrentHashMap<String, String>()
    private val cancelledSaves = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var picker: String? = null
    private val parts = ConcurrentHashMap.newKeySet<File>()
    @Volatile private var destroyed = false

    private fun answer(id: String, result: JSONObject, transfer: Transfer? = null) {
        if (transfer == null || transfer.finished.compareAndSet(false, true)) {
            if (transfer != null) transfers.remove(id, transfer)
            if (!destroyed) deliver(id, result)
        }
    }
    private fun failure(code: String) = JSONObject().put("ok", false).put("code", code)
    private fun cancelled() = JSONObject().put("ok", false).put("cancelled", true)
    private fun accepted() = JSONObject().put("ok", true).toString()
    private fun bad(error: String) = JSONObject().put("ok", false).put("error", error).toString()
    private fun valid(id: String) = PanelFiles.validCallId(id) && !destroyed
    private fun submit(id: String, document: PendingDocument? = null, job: (Transfer) -> JSONObject): String {
        if (!valid(id)) {
            document?.discard()
            return bad("invalid call id")
        }
        val transfer = Transfer(document)
        if (transfers.putIfAbsent(id, transfer) != null) {
            document?.discard()
            return bad("duplicate call id")
        }
        try {
            executor.execute {
                synchronized(transfer) { transfer.started = true }
                try {
                    val result = if (transfer.cancelled) cancelled() else job(transfer)
                    transfer.document?.discard()
                    answer(id, result, transfer)
                } catch (_: Exception) {
                    HostLog.event("panel file transfer failed")
                    transfer.document?.discard()
                    answer(id, if (transfer.cancelled) cancelled() else failure("UNAVAILABLE"), transfer)
                } finally {
                    transfer.stop()
                    transfer.document?.discard()
                }
            }
        } catch (_: Exception) {
            transfers.remove(id, transfer)
            transfer.stop()
            transfer.document?.discard()
            return failure("UNAVAILABLE").toString()
        }
        return accepted()
    }

    /**
     * Sticker Studio asks for images and videos only; the panel's file forms
     * (feedback attachment, scheduled-message media) pass [anyFile] and take
     * whatever the operator picks.
     */
    fun pick(id: String, anyFile: Boolean = false): String {
        if (!valid(id)) return bad("invalid call id")
        val previous = picker
        if (previous != null) answer(previous, cancelled())
        picker = id
        launchPicker(id, anyFile)
        return accepted()
    }

    fun picked(id: String, uri: Uri?) {
        if (picker != id || destroyed) return
        picker = null
        if (uri == null) return answer(id, cancelled())
        try {
            var name = "sticker"
            var size = -1L
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    name = cursor.getString(0) ?: name
                    size = if (cursor.isNull(1)) -1 else cursor.getLong(1)
                }
            }
            val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
            val token = sources.register(uri.toString(), name, mime, size)
            val registered = sources.get(token)!!
            answer(id, JSONObject().put("ok", true).put("token", token).put("name", registered.name)
                .put("mime", registered.mime).put("size", size).put("url", PanelHttp.ORIGIN + "/__levix-host/source/" + token))
        } catch (error: Exception) {
            HostLog.event("sticker pick ${error.message}")
            answer(id, failure("UNAVAILABLE"))
        }
    }

    fun takePending(): String {
        val pending = PendingStickers.take() ?: return JSONObject().put("ok", false).toString()
        var size = -1L
        runCatching {
            context.contentResolver.query(pending.uri.toUri(), arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
                if (it.moveToFirst() && !it.isNull(0)) size = it.getLong(0)
            }
        }
        val token = sources.register(pending.uri, pending.name, pending.mime, size)
        val registered = sources.get(token)!!
        return JSONObject().put("ok", true)
            .put("intent", if (pending.intent == StickerIntent.CREATE) "create" else "save")
            .put("name", registered.name).put("mime", registered.mime).put("size", size)
            .put("token", token).put("url", PanelHttp.ORIGIN + "/__levix-host/source/" + token).toString()
    }

    fun upload(id: String, token: String, name: String, maxBytes: Long): String {
        if (!valid(id)) return bad("invalid call id")
        if (maxBytes < 1) return bad("invalid upload limit")
        if (sources.get(token) == null) return failure("UNAVAILABLE").toString()
        return submit(id) { transfer ->
            val source = sources.get(token) ?: return@submit failure("UNAVAILABLE")
            val stream = try { context.contentResolver.openInputStream(source.uri.toUri()) }
                catch (_: Exception) { null } ?: return@submit failure("UNAVAILABLE")
            transfer.source = stream
            val body = ByteArrayOutputStream()
            try {
                val response = PanelHttp.stream(sock, "POST", "/dashboard/api/stickers/uploads",
                    mapOf("X-Filename" to Uri.encode(name), "Content-Type" to "application/octet-stream"),
                    null, stream, maxBytes, {
                        if (transfer.cancelled) it.close() else transfer.socket = it
                    }, { 64 * 1024L }, { body })
                JSONObject().put("ok", true).put("status", response.status)
                    .put("body", body.toString(Charsets.UTF_8.name()))
            } catch (_: PanelWire.TooLarge) {
                failure("TOO_LARGE")
            } catch (error: Exception) {
                if (error.message == "NO_MEDIA") failure("NO_MEDIA")
                else if (transfer.cancelled) cancelled() else failure("UNAVAILABLE")
            }
        }
    }

    /** A picked document goes straight to the restore upload route over the panel socket. */
    fun uploadBackup(id: String, token: String, maxBytes: Long): String {
        if (!valid(id)) return bad("invalid call id")
        if (!PanelFiles.backupSize(maxBytes)) return bad("invalid upload limit")
        if (sources.get(token) == null) return failure("UNAVAILABLE").toString()
        return submit(id) { transfer ->
            val source = sources.get(token) ?: return@submit failure("UNAVAILABLE")
            val uri = source.uri.toUri()
            var size = -1L
            try {
                context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
                    if (it.moveToFirst() && !it.isNull(0)) size = it.getLong(0)
                }
            } catch (_: Exception) { return@submit failure("UNAVAILABLE") }
            if (size < 0) return@submit failure("SIZE_UNKNOWN")
            if (size > maxBytes) return@submit failure("TOO_LARGE")
            if (size == 0L) return@submit failure("BAD_LENGTH")
            val stream = try { context.contentResolver.openInputStream(uri) }
                catch (_: Exception) { null } ?: return@submit failure("UNAVAILABLE")
            transfer.source = stream
            val body = ByteArrayOutputStream()
            var lastProgress = 0L
            try {
                val response = PanelHttp.stream(sock, "POST", PanelFiles.BACKUP_UPLOAD,
                    mapOf("Content-Type" to "application/octet-stream"), null, stream, maxBytes,
                    { if (transfer.cancelled) it.close() else transfer.socket = it },
                    { 64 * 1024L }, { body }, exactLength = size,
                    onUploadProgress = { copied ->
                        if (copied - lastProgress >= 256 * 1024 || copied == size) {
                            lastProgress = copied
                            if (!transfer.cancelled) progress(id, copied, size)
                        }
                    })
                if (transfer.cancelled) cancelled() else JSONObject().put("ok", true)
                    .put("status", response.status).put("body", body.toString(Charsets.UTF_8.name()))
            } catch (_: PanelWire.WrongLength) {
                if (transfer.cancelled) cancelled() else failure("BAD_LENGTH")
            } catch (_: Exception) {
                if (transfer.cancelled) cancelled() else failure("UNAVAILABLE")
            }
        }
    }

    /** Reserve the call while Android's create-document dialog is open. */
    @Synchronized
    fun saveBackup(id: String, token: String, fileName: String): String {
        if (!valid(id)) return bad("invalid call id")
        if (!PanelFiles.backupToken(token) || !PanelFiles.backupFileName(fileName))
            return bad("invalid backup export")
        if (pendingSaves.isNotEmpty()) return bad("save dialog busy")
        if (transfers.containsKey(id) || pendingSaves.putIfAbsent(id, token) != null)
            return bad("duplicate call id")
        try { launchBackupSave(id, fileName) }
        catch (_: Exception) {
            pendingSaves.remove(id)
            return failure("UNAVAILABLE").toString()
        }
        return accepted()
    }

    @Synchronized
    fun backupSavePicked(id: String, uri: Uri?) {
        val token = pendingSaves.remove(id)
        val wasCancelled = cancelledSaves.remove(id)
        if (token == null || wasCancelled || destroyed) {
            if (uri != null) deleteDocument(uri)
            if (token == null && id.isNotEmpty() && !destroyed) answer(id, cancelled())
            return
        }
        if (uri == null) return answer(id, cancelled())
        val path = "/dashboard/api/backup/exports/$token"
        if (!PanelFiles.backupExportAllowed(path)) {
            deleteDocument(uri)
            return answer(id, failure("UNAVAILABLE"))
        }
        val document = PendingDocument { deleteDocument(uri) }
        val accepted = submit(id, document) { transfer ->
            val errors = ByteArrayOutputStream()
            var output: OutputStream? = null
            try {
                val response = PanelHttp.stream(sock, "GET", path, emptyMap(), null, null, 0,
                    { if (transfer.cancelled) it.close() else transfer.socket = it },
                    { if (it.status == 200) PanelFiles.BACKUP_MAX_BYTES + 1 else 64 * 1024L },
                    { head ->
                        if (head.status != 200) errors else {
                            output = context.contentResolver.openOutputStream(uri, "w")
                                ?: throw java.io.IOException("cannot open document")
                            transfer.output = output
                            output!!
                        }
                    })
                output?.close()
                output = null
                transfer.output = null
                if (response.status != 200) failure("UNAVAILABLE")
                else if (response.bytes == 0L || response.bytes > PanelFiles.BACKUP_MAX_BYTES)
                    failure("BAD_LENGTH")
                else synchronized(transfer) {
                    if (transfer.cancelled) cancelled() else {
                        check(document.keep()) { "document was discarded" }
                        val result = JSONObject().put("ok", true)
                        answer(id, result, transfer)
                        result
                    }
                }
            } catch (_: Exception) {
                if (transfer.cancelled) cancelled() else failure("UNAVAILABLE")
            } finally {
                runCatching { output?.close() }
            }
        }
        if (!JSONObject(accepted).optBoolean("ok")) answer(id, failure("UNAVAILABLE"))
    }

    @Synchronized
    fun backupSaveFailed(id: String) {
        if (pendingSaves.remove(id) != null && !cancelledSaves.remove(id))
            answer(id, failure("UNAVAILABLE"))
    }

    private fun deleteDocument(uri: Uri) {
        runCatching { DocumentsContract.deleteDocument(context.contentResolver, uri) }
    }

    /**
     * Generic multipart upload for the panel forms the WebView cannot carry
     * itself (feedback attachment, scheduled-message media): the payload
     * fields ride as text parts, the picked file streams as the "file" part,
     * and the whole body goes over the same authenticated socket as the panel
     * requests. The route is pinned by PanelFiles.uploadAllowed.
     */
    fun uploadForm(id: String, path: String, payloadJson: String, token: String, maxBytes: Long): String {
        if (!valid(id)) return bad("invalid call id")
        if (!PanelFiles.uploadAllowed(path)) return bad("invalid upload route")
        if (maxBytes < 1) return bad("invalid upload limit")
        if (payloadJson.toByteArray(Charsets.UTF_8).size > 64 * 1024) return bad("request is too large")
        if (sources.get(token) == null) return failure("UNAVAILABLE").toString()
        return submit(id) { transfer ->
            val source = sources.get(token) ?: return@submit failure("UNAVAILABLE")
            val stream = try { context.contentResolver.openInputStream(source.uri.toUri()) }
                catch (_: Exception) { null } ?: return@submit failure("UNAVAILABLE")
            transfer.source = stream
            val payload = try { JSONObject(payloadJson.ifBlank { "{}" }) } catch (_: Exception) { JSONObject() }
            val boundary = "levix" + java.util.UUID.randomUUID().toString().replace("-", "")
            val fields = StringBuilder()
            val keys = payload.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val value = payload.optString(key, "")
                if (value.isEmpty()) continue
                fields.append("--").append(boundary).append("\r\n")
                    .append("Content-Disposition: form-data; name=\"")
                    .append(key.replace("\"", "")).append("\"\r\n\r\n")
                    .append(value).append("\r\n")
            }
            val fileName = Uri.encode(source.name.ifBlank { "file" })
            fields.append("--").append(boundary).append("\r\n")
                .append("Content-Disposition: form-data; name=\"file\"; filename=\"")
                .append(fileName).append("\"; filename*=UTF-8''").append(fileName).append("\r\n")
                .append("Content-Type: ").append(source.mime.ifBlank { "application/octet-stream" })
                .append("\r\n\r\n")
            val preamble = fields.toString().toByteArray(Charsets.UTF_8)
            val epilogue = "\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8)
            val body = ByteArrayOutputStream()
            try {
                val combined = java.io.SequenceInputStream(
                    java.io.SequenceInputStream(preamble.inputStream(), stream),
                    epilogue.inputStream(),
                )
                val response = PanelHttp.stream(sock, "POST", path,
                    mapOf("Content-Type" to "multipart/form-data; boundary=$boundary"),
                    null, combined, maxBytes, {
                        // The feedback route forwards the file upstream and
                        // may wait up to 120 s for the answer; the default 60 s
                        // read timeout would report a delivered send as failed.
                        it.soTimeout = FORM_RESPONSE_TIMEOUT_MS
                        if (transfer.cancelled) it.close() else transfer.socket = it
                    }, { 64 * 1024L }, { body })
                JSONObject().put("ok", true).put("status", response.status)
                    .put("body", body.toString(Charsets.UTF_8.name()))
            } catch (_: PanelWire.TooLarge) {
                failure("TOO_LARGE")
            } catch (error: Exception) {
                if (error.message == "NO_MEDIA") failure("NO_MEDIA")
                else if (transfer.cancelled) cancelled() else failure("UNAVAILABLE")
            }
        }
    }

    fun export(id: String, action: String, path: String, method: String, jsonBody: String,
        fileName: String, mime: String): String {
        if (!valid(id)) return bad("invalid call id")
        if (action != "share" && action != "save") return bad("invalid action")
        if (!PanelFiles.exportAllowed(path, method)) return bad("invalid export route")
        val panelMime = PanelFiles.sharedMime(mime) ?: return bad("invalid file type")
        if (jsonBody.toByteArray(Charsets.UTF_8).size > 64 * 1024) return bad("request is too large")
        return submit(id) { transfer ->
            val safe = PanelFiles.sanitizeName(fileName, "levix-sticker")
            val errors = ByteArrayOutputStream()
            var part: File? = null
            var download: Uri? = null
            var output: java.io.OutputStream? = null
            var responseMime = panelMime
            try {
                val response = PanelHttp.stream(sock, method, path,
                    if (method == "POST") mapOf("Content-Type" to "application/json") else emptyMap(),
                    if (method == "POST") jsonBody else null, null, 0, {
                        if (transfer.cancelled) it.close() else transfer.socket = it
                    },
                    { if (it.status in 200..299) Long.MAX_VALUE else 64 * 1024L },
                    { head ->
                        if (head.status !in 200..299) errors
                        else {
                            val actual = PanelFiles.sharedMime(head.header("Content-Type") ?: "")
                            require(actual != null) { "invalid response file type" }
                            responseMime = actual
                            if (action == "share") {
                                val folder = File(context.cacheDir, PanelFiles.SHARED_DIR).apply { mkdirs() }
                                sweep(folder)
                                part = File(folder, "$safe.part").also { parts.add(it) }
                                part!!.outputStream().also { output = it; transfer.output = it }
                            } else {
                                val values = ContentValues().apply {
                                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                                    put(MediaStore.Downloads.MIME_TYPE, actual)
                                    put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Levix")
                                    put(MediaStore.Downloads.IS_PENDING, 1)
                                }
                                download = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                                    ?: error("Downloads is not writable")
                                context.contentResolver.openOutputStream(download!!)?.also {
                                    output = it
                                    transfer.output = it
                                }
                                    ?: error("Downloads is not writable")
                            }
                        }
                    })
                output?.close()
                output = null
                transfer.output = null
                if (response.status !in 200..299) {
                    JSONObject().put("ok", false).put("status", response.status)
                        .put("body", errors.toString(Charsets.UTF_8.name()))
                } else {
                    synchronized(transfer) {
                        if (transfer.cancelled) return@submit cancelled()
                        val result = if (action == "share") {
                            val target = File(part!!.parentFile, safe)
                            require(part!!.renameTo(target)) { "could not finish shared file" }
                            parts.remove(part!!)
                            share(target, responseMime)
                            JSONObject().put("ok", true)
                        } else {
                            require(context.contentResolver.update(download!!,
                                ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null) > 0) {
                                "could not publish download"
                            }
                            download = null
                            JSONObject().put("ok", true).put("name", safe)
                                .put("dir", "${Environment.DIRECTORY_DOWNLOADS}/Levix")
                        }
                        answer(id, result, transfer)
                        result
                    }
                }
            } finally {
                runCatching { output?.close() }
                part?.let { parts.remove(it); it.delete() }
                download?.let { context.contentResolver.delete(it, null, null) }
            }
        }
    }

    fun cancel(id: String): String {
        if (!PanelFiles.validCallId(id)) return bad("invalid call id")
        synchronized(this) {
            if (pendingSaves.containsKey(id) && cancelledSaves.add(id)) {
                answer(id, cancelled())
            }
            transfers[id]?.let {
                synchronized(it) {
                    it.stop()
                    // A running job closes its output before deleting the
                    // document. A queued job may never run after shutdown.
                    if (!it.started) it.document?.discard()
                    answer(id, cancelled(), it)
                }
            }
        }
        return accepted()
    }

    fun destroy() {
        // First, so nothing below posts a result into a WebView being torn down.
        destroyed = true
        picker = null
        pendingSaves.clear()
        cancelledSaves.clear()
        transfers.forEach { (id, _) -> cancel(id) }
        executor.shutdownNow()
        sources.clear()
        parts.forEach { it.delete() }
        parts.clear()
    }

    private fun sweep(folder: File) {
        val cutoff = System.currentTimeMillis() - PanelFiles.SHARED_MAX_AGE_MS
        folder.listFiles()?.forEach { if (it.isFile && it.lastModified() < cutoff) it.delete() }
    }

    private companion object {
        /** Above the 120 s upstream timeout in src/panel/feedback.cjs. */
        const val FORM_RESPONSE_TIMEOUT_MS = 150_000
    }
}
