package net.leviro.levix

import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import androidx.core.net.toUri
import net.leviro.levix.media.PendingSticker
import net.leviro.levix.media.PendingStickers
import net.leviro.levix.media.StickerIntent
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream

/**
 * fetch / XHR / form POST from the panel page. WebView intercept cannot
 * read POST bodies; those go through this bridge onto the unix socket.
 *
 * Also carries Sticker Studio's file hand-offs (a Media Hub pick in, an export
 * or a pack ZIP out). Every @JavascriptInterface call runs on the WebView's
 * JavaBridge thread, never the UI thread, so the reads and writes below may
 * block — but each one is capped at PanelFiles.MAX_BRIDGE_BYTES, because the
 * bytes become ONE base64 string on the JavaScript side and the caller waits.
 */
class PanelBridge(
    private val sock: File,
    private val bridgeJs: String = "",
    private val onPickContact: (() -> Unit)? = null,
    private val appContext: Context? = null,
    private val onShareLogs: (() -> Unit)? = null,
    private val onClosePanel: (() -> Unit)? = null,
    private val onShareFile: ((File, String) -> Unit)? = null,
) {
    @JavascriptInterface
    fun pickContact() {
        onPickContact?.invoke()
    }

    /**
     * Returns the last N lines of the Android host log so the panel's
     * Logs tab can display them without leaving the WebView.
     */
    @JavascriptInterface
    fun hostLog(maxLines: Int): String {
        return try {
            val capped = maxLines.coerceIn(1, 500)
            HostLog.readRecentLines(capped)
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * Triggers the native share-logs flow (same as the Share button
     * on the native dashboard) from inside the WebView panel.
     */
    @JavascriptInterface
    fun shareHostLogs() {
        onShareLogs?.invoke()
    }

    /**
     * Closes the panel WebView and returns to the native dashboard.
     * Called from the panel's "Back to app" header button.
     */
    @JavascriptInterface
    fun closePanel() {
        onClosePanel?.invoke()
    }

    /**
     * The panel hands its settings export to the host instead of a download:
     * a WebView has no download manager wired for the blob: URLs the page
     * creates, so the file would vanish. It lands in Downloads/Levix, where
     * every Files app looks, and the return value is what the panel shows the
     * operator as the save location.
     */
    @JavascriptInterface
    fun saveExportFile(fileName: String, base64: String): String {
        val context = appContext
        return try {
            requireNotNull(context) { "no host context" }
            require(fileName.isNotBlank()) { "file name is required" }
            val safeName = fileName.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120)
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                put(MediaStore.Downloads.MIME_TYPE, "application/json")
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Levix")
            }
            val uri = context.contentResolver
                .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("Downloads is not writable")
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: error("could not open the file for writing")
            JSONObject()
                .put("ok", true)
                .put("name", safeName)
                .put("dir", "${Environment.DIRECTORY_DOWNLOADS}/Levix")
                .toString()
        } catch (error: Exception) {
            HostLog.event("panel saveExport ${error.message}")
            JSONObject()
                .put("ok", false)
                .put("error", error.message ?: "save failed")
                .toString()
        }
    }

    /**
     * Sticker Studio's pick-from-the-Media-Hub door. The native screen parked a
     * URI, the panel asks for it once on open, gets the bytes as base64 and
     * uploads them to its own server like any other upload.
     *
     * One-shot by construction: PendingStickers.take() already cleared the
     * holder, so a failed read leaves nothing behind to be picked up by the
     * next page load and converted twice.
     */
    @JavascriptInterface
    fun takePendingSticker(): String {
        return try {
            val context = requireNotNull(appContext) { "no host context" }
            val pending = PendingStickers.take() ?: return pendingStickerUnavailable()
            val bytes = readBounded(context.contentResolver.openInputStream(pending.uri.toUri()))
                ?: return pendingStickerUnavailable()
            JSONObject()
                .put("ok", true)
                .put("intent", if (pending.intent == StickerIntent.CREATE) "create" else "save")
                .put("name", pending.name)
                .put("mime", pending.mime)
                .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .toString()
        } catch (error: Exception) {
            HostLog.event("panel pending sticker ${error.message}")
            pendingStickerUnavailable()
        }
    }

    /** No pending pick, an unreadable one, or one over the cap — all the same to the panel. */
    private fun pendingStickerUnavailable(): String = JSONObject().put("ok", false).toString()

    /**
     * shareFile(fileName, mime, base64) from the panel: the sticker, its PNG /
     * GIF form, an MP4 or a pack ZIP leaves the app through the system share
     * sheet, which needs a real file and a read grant — a blob: URL in a WebView
     * cannot do either.
     *
     * The activity owns the chooser (it has to), so the bytes are decoded and
     * written here and only the finished File is handed over.
     */
    @JavascriptInterface
    fun shareFile(fileName: String, mime: String, base64: String): String {
        return try {
            val context = requireNotNull(appContext) { "no host context" }
            val shareMime = PanelFiles.sharedMime(mime)
            require(shareMime != null) { "that file type cannot be shared" }
            val bytes = decodeBounded(base64)
            val safeName = PanelFiles.sanitizeName(fileName, "levix-sticker")
            val share = onShareFile ?: error("the share sheet is not available")
            val file = writeSharedFile(context, safeName, bytes)
            runCatching { share(file, shareMime) }
                .onFailure { HostLog.event("panel share file ${it.message}") }
            JSONObject()
                .put("ok", true)
                .toString()
        } catch (error: Exception) {
            HostLog.event("panel shareFile ${error.message}")
            JSONObject()
                .put("ok", false)
                .put("error", error.message ?: "share failed")
                .toString()
        }
    }

    /**
     * saveDownload(fileName, mime, base64): the same Downloads/Levix landing
     * spot as the settings export, but with the MIME type and name the panel
     * chose instead of assuming a JSON blob.
     */
    @JavascriptInterface
    fun saveDownload(fileName: String, mime: String, base64: String): String {
        val context = appContext
        return try {
            requireNotNull(context) { "no host context" }
            val saveMime = PanelFiles.sharedMime(mime)
            require(saveMime != null) { "that file type cannot be saved" }
            require(fileName.isNotBlank()) { "file name is required" }
            val safeName = PanelFiles.sanitizeName(fileName, "levix-sticker")
            val bytes = decodeBounded(base64)
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                put(MediaStore.Downloads.MIME_TYPE, saveMime)
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Levix")
            }
            val uri = context.contentResolver
                .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("Downloads is not writable")
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: error("could not open the file for writing")
            JSONObject()
                .put("ok", true)
                .put("name", safeName)
                .put("dir", "${Environment.DIRECTORY_DOWNLOADS}/Levix")
                .toString()
        } catch (error: Exception) {
            HostLog.event("panel saveDownload ${error.message}")
            JSONObject()
                .put("ok", false)
                .put("error", error.message ?: "save failed")
                .toString()
        }
    }

    /**
     * Decodes a bridge payload, refusing anything over the cap on the encoded
     * length first: a 100 MB string must not become a 75 MB byte array before
     * the size check gets to say no.
     */
    private fun decodeBounded(base64: String): ByteArray {
        require(PanelFiles.encodedFitsCap(base64)) { "that file is too large to share" }
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        require(PanelFiles.fitsBridgeCap(bytes.size.toLong())) { "that file is too large to share" }
        return bytes
    }

    /**
     * Reads a content:// stream up to the cap. One byte over the limit stops
     * the read instead of buffering the rest: the point of the cap is to never
     * hold the oversized file, not to find out how oversized it was.
     */
    private fun readBounded(input: InputStream?): ByteArray? {
        if (input == null) return null
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(64 * 1024)
        var total = 0L
        input.use { stream ->
            while (true) {
                val read = stream.read(chunk)
                if (read < 0) break
                total += read
                if (total > PanelFiles.MAX_BRIDGE_BYTES) return null
                buffer.write(chunk, 0, read)
            }
        }
        return buffer.toByteArray().takeIf { it.isNotEmpty() }
    }

    /**
     * Writes into the FileProvider's cache folder. Stale copies are swept
     * first so a long-running host does not keep every sticker it ever shared.
     */
    private fun writeSharedFile(context: Context, fileName: String, bytes: ByteArray): File {
        val folder = File(context.cacheDir, PanelFiles.SHARED_DIR)
        folder.mkdirs()
        sweepSharedFolder(folder)
        val target = File(folder, fileName)
        target.outputStream().use { it.write(bytes) }
        return target
    }

    private fun sweepSharedFolder(folder: File) {
        val cutoff = System.currentTimeMillis() - PanelFiles.SHARED_MAX_AGE_MS
        folder.listFiles()?.forEach { candidate ->
            if (candidate.isFile && candidate.lastModified() < cutoff) candidate.delete()
        }
    }

    @JavascriptInterface
    fun request(url: String, method: String, headersJson: String, bodyB64: String): String {
        return try {
            require(PanelActivity.isLoopback(url)) { "panel bridge only accepts loopback HTTP URLs" }
            val headers = mutableMapOf<String, String>()
            val parsed = JSONObject(headersJson.ifBlank { "{}" })
            val keys = parsed.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                headers[key] = parsed.getString(key)
            }
            val body = if (bodyB64.isEmpty()) {
                ByteArray(0)
            } else {
                Base64.decode(bodyB64, Base64.DEFAULT)
            }
            val exchange = PanelHttp.exchange(sock, method, url, headers, body)
            if (!method.equals("GET", true) && !method.equals("HEAD", true)) {
                HostLog.event("panel bridge $method ${exchange.status} ${exchange.url}")
            }
            var responseBody = exchange.body
            val contentType = exchange.header("Content-Type") ?: ""
            if (bridgeJs.isNotEmpty() && contentType.contains("text/html", ignoreCase = true)) {
                responseBody = PanelHttp.injectBridge(
                    String(responseBody, Charsets.UTF_8),
                    bridgeJs,
                ).toByteArray(Charsets.UTF_8)
            }
            val out = JSONObject()
            out.put("status", exchange.status)
            out.put("statusText", exchange.reason)
            out.put("url", exchange.url)
            val hdr = JSONObject()
            exchange.headerMap().forEach { (k, v) -> hdr.put(k, v) }
            out.put("headers", hdr)
            out.put("body", Base64.encodeToString(responseBody, Base64.NO_WRAP))
            out.toString()
        } catch (error: Exception) {
            HostLog.event("panel bridge ${error.message}")
            val out = JSONObject()
            out.put("status", 502)
            out.put("statusText", "Bad Gateway")
            out.put("url", url)
            out.put("headers", JSONObject())
            out.put(
                "body",
                Base64.encodeToString(
                    (error.message ?: "panel socket error").toByteArray(Charsets.UTF_8),
                    Base64.NO_WRAP,
                ),
            )
            out.toString()
        }
    }
}
