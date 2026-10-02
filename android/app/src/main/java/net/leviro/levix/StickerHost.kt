package net.leviro.levix

import android.content.ContentValues
import android.content.Context
import android.net.LocalSocket
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
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
    private val launchPicker: (String) -> Unit,
    private val share: (File, String) -> Unit,
) {
    private class Transfer {
        val finished = AtomicBoolean(false)
        @Volatile var socket: LocalSocket? = null
        @Volatile var source: InputStream? = null
        @Volatile var output: OutputStream? = null
        @Volatile var cancelled = false
        fun stop() {
            cancelled = true
            runCatching { socket?.close() }
            runCatching { source?.close() }
            runCatching { output?.close() }
        }
    }
    private val executor = Executors.newSingleThreadExecutor()
    private val transfers = ConcurrentHashMap<String, Transfer>()
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
    private fun submit(id: String, job: (Transfer) -> JSONObject): String {
        if (!valid(id)) return bad("invalid call id")
        val transfer = Transfer()
        if (transfers.putIfAbsent(id, transfer) != null) return bad("duplicate call id")
        executor.execute {
            try {
                if (transfer.cancelled) answer(id, cancelled(), transfer)
                else answer(id, job(transfer), transfer)
            } catch (error: Exception) {
                HostLog.event("sticker transfer ${error.message}")
                answer(id, if (transfer.cancelled) cancelled() else failure("UNAVAILABLE"), transfer)
            } finally {
                transfer.stop()
            }
        }
        return accepted()
    }

    fun pick(id: String): String {
        if (!valid(id)) return bad("invalid call id")
        val previous = picker
        if (previous != null) answer(previous, cancelled())
        picker = id
        launchPicker(id)
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
        transfers[id]?.let {
            synchronized(it) {
                it.stop()
                answer(id, cancelled(), it)
            }
        }
        return accepted()
    }

    fun destroy() {
        // First, so nothing below posts a result into a WebView being torn down.
        destroyed = true
        picker = null
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
}
