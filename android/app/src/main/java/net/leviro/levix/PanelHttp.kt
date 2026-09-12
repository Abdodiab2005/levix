package net.leviro.levix

import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.net.LocalSocket
import android.net.LocalSocketAddress
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.nio.charset.Charset
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * HTTP/1.1 client over Node's unix panel socket.
 *
 * This app cannot bind TCP (socket() returns ECONNREFUSED). The WebView still
 * loads http://127.0.0.1:3001/; [intercept] answers those requests here.
 */
object PanelHttp {
    const val ORIGIN = "http://127.0.0.1:3001"
    private const val SOCK_NAME = "panel.sock"
    private const val CONNECT_MS = 8_000L
    private const val IO_TIMEOUT_MS = 60_000
    private val HOP_BY_HOP = setOf(
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "content-encoding",
        "set-cookie",
        "etag",
        "last-modified",
    )

    @Volatile
    private var loggedOk = false

    data class Exchange(
        val status: Int,
        val reason: String,
        val headers: List<Pair<String, String>>,
        val body: ByteArray,
        val url: String,
    ) {
        fun header(name: String): String? =
            headers.firstOrNull { it.first.equals(name, ignoreCase = true) }?.second

        fun headerMap(): Map<String, String> {
            val out = linkedMapOf<String, String>()
            for ((name, value) in headers) {
                if (name.lowercase(Locale.US) in HOP_BY_HOP) continue
                val previous = out[name]
                out[name] = if (previous == null) value else "$previous, $value"
            }
            out["Cache-Control"] = "no-cache, no-store, must-revalidate"
            out["Pragma"] = "no-cache"
            return out
        }
    }

    fun sockFile(filesDir: File): File = File(File(filesDir, "data"), SOCK_NAME)

    fun intercept(sock: File, request: WebResourceRequest, bridgeJs: String): WebResourceResponse {
        return try {
            interceptInner(sock, request, bridgeJs)
        } catch (error: Throwable) {
            HostLog.event("panel intercept ${error.javaClass.simpleName}: ${error.message}")
            fail(error.message ?: "intercept error")
        }
    }

    private fun interceptInner(
        sock: File,
        request: WebResourceRequest,
        bridgeJs: String,
    ): WebResourceResponse {
        val url = request.url?.toString() ?: return fail("missing url")
        val method = request.method ?: "GET"
        val upgrade = request.requestHeaders?.entries?.any {
            it.key.equals("Upgrade", true) && it.value.contains("websocket", true)
        } == true
        if (upgrade) {
            HostLog.event("panel unix skip websocket ${pathOf(url)}")
            return WebResourceResponse(
                "text/plain",
                "utf-8",
                404,
                "Not Found",
                mapOf("Content-Type" to "text/plain"),
                ByteArrayInputStream(ByteArray(0)),
            )
        }
        if (method != "GET" && method != "HEAD" && method != "OPTIONS") {
            // POST bodies are not exposed here. The injected bridge handles them.
            return fail("use the in-page bridge for $method")
        }
        val headers = linkedMapOf<String, String>()
        request.requestHeaders?.forEach { (k, v) -> headers[k] = v }
        val exchange = try {
            exchange(sock, method, url, headers, ByteArray(0))
        } catch (error: Exception) {
            HostLog.event("panel unix ${error.message}")
            return fail(error.message ?: "panel socket error")
        }
        var body = exchange.body
        var mime = contentType(exchange.header("Content-Type"))
        val charset = charsetOf(exchange.header("Content-Type"))
        val encoding = if (isTextMime(mime)) charset.name() else null
        if (method != "HEAD" && mime.startsWith("text/html") && bridgeJs.isNotEmpty()) {
            val html = String(body, charset)
            body = injectBridge(html, bridgeJs).toByteArray(charset)
        }
        val status = safeStatus(exchange.status)
        val path = pathOf(url)
        if (!loggedOk || status !in 200..299 || mime.startsWith("text/html")) {
            loggedOk = true
            HostLog.event("panel unix ${exchange.status}->$status $method $path")
        }
        return WebResourceResponse(
            mime,
            encoding,
            status,
            if (status == 200) "OK" else exchange.reason.ifBlank { "OK" },
            exchange.headerMap(),
            ByteArrayInputStream(body),
        )
    }

    /**
     * WebResourceResponse rejects [300, 399] (including 304) and crashes the
     * host process if we throw from shouldInterceptRequest.
     */
    private fun safeStatus(status: Int): Int {
        if (status in 300..399) return 200
        // 101 Switching Protocols (websocket) crashes Chromium inside WebResourceResponse.
        if (status == 101) return 404
        if (status in 200..599) return status
        return 502
    }

    fun exchange(
        sock: File,
        method: String,
        url: String,
        headers: Map<String, String>,
        body: ByteArray,
    ): Exchange {
        var currentMethod = method.uppercase(Locale.US)
        var currentUrl = url
        var currentBody = if (currentMethod == "GET" || currentMethod == "HEAD") ByteArray(0) else body
        repeat(5) {
            val one = once(sock, currentMethod, currentUrl, headers, currentBody)
            applySetCookie(currentUrl, one.headers)
            val location = one.header("Location")
            if (location == null || one.status !in 300..399) {
                return one.copy(url = currentUrl)
            }
            currentMethod = "GET"
            currentBody = ByteArray(0)
            currentUrl = URI(currentUrl).resolve(location).toString()
        }
        throw IOException("too many redirects")
    }

    private fun once(
        sock: File,
        method: String,
        url: String,
        headers: Map<String, String>,
        body: ByteArray,
    ): Exchange {
        val uri = URI(url)
        val path = buildString {
            append(uri.rawPath?.ifBlank { "/" } ?: "/")
            if (!uri.rawQuery.isNullOrEmpty()) append('?').append(uri.rawQuery)
        }
        val local = connect(sock)
        try {
            val out = local.outputStream
            writeRequest(out, method, path, uri, headers, body)
            val input = BufferedInputStream(local.inputStream)
            return readResponse(input, url)
        } finally {
            try {
                local.close()
            } catch (_: Exception) {
            }
        }
    }

    private fun writeRequest(
        out: OutputStream,
        method: String,
        path: String,
        uri: URI,
        headers: Map<String, String>,
        body: ByteArray,
    ) {
        val host = if (uri.port > 0) "${uri.host}:${uri.port}" else (uri.host ?: "127.0.0.1:3001")
        val sent = linkedMapOf<String, String>()
        fun put(name: String, value: String) {
            val key = sent.keys.firstOrNull { it.equals(name, ignoreCase = true) }
            if (key != null) sent.remove(key)
            sent[name] = value
        }
        headers.forEach { (k, v) -> put(k, v) }
        // WebView cache validators turn into 304, which WebResourceResponse rejects.
        listOf("If-None-Match", "If-Modified-Since", "If-Unmodified-Since", "If-Range")
            .forEach { name ->
                sent.keys.filter { it.equals(name, ignoreCase = true) }.toList().forEach { sent.remove(it) }
            }
        put("Host", host)
        put("Connection", "close")
        put("Accept-Encoding", "identity")
        put("Cache-Control", "no-cache, no-store, must-revalidate")
        put("Pragma", "no-cache")
        if (!sent.keys.any { it.equals("Origin", true) }) put("Origin", ORIGIN)
        if (!sent.keys.any { it.equals("Sec-Fetch-Site", true) }) put("Sec-Fetch-Site", "same-origin")
        val cookie = CookieManager.getInstance().getCookie(uri.toString())
            ?: CookieManager.getInstance().getCookie(ORIGIN)
        if (cookie != null && !sent.keys.any { it.equals("Cookie", true) }) {
            put("Cookie", cookie)
        }
        if (body.isNotEmpty()) put("Content-Length", body.size.toString())
        else if (method != "GET" && method != "HEAD") put("Content-Length", "0")

        val buf = StringBuilder()
        buf.append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
        for ((name, value) in sent) {
            buf.append(name).append(": ").append(value).append("\r\n")
        }
        buf.append("\r\n")
        out.write(buf.toString().toByteArray(Charsets.US_ASCII))
        if (body.isNotEmpty() && method != "HEAD") out.write(body)
        out.flush()
    }

    private fun readResponse(input: BufferedInputStream, url: String): Exchange {
        val statusLine = readLine(input) ?: throw IOException("empty panel response")
        val parts = statusLine.split(" ", limit = 3)
        val status = parts.getOrNull(1)?.toIntOrNull() ?: throw IOException("bad status: $statusLine")
        val reason = parts.getOrNull(2) ?: ""
        val headers = mutableListOf<Pair<String, String>>()
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            val idx = line.indexOf(':')
            if (idx <= 0) continue
            headers.add(line.substring(0, idx).trim() to line.substring(idx + 1).trim())
        }
        val header = { name: String ->
            headers.firstOrNull { it.first.equals(name, ignoreCase = true) }?.second
        }
        val body = when {
            status == 204 || status == 304 -> ByteArray(0)
            header("Transfer-Encoding")?.contains("chunked", ignoreCase = true) == true ->
                readChunked(input)
            header("Content-Length") != null -> {
                val n = header("Content-Length")!!.toIntOrNull() ?: 0
                if (n <= 0) ByteArray(0) else readFully(input, n)
            }
            else -> input.readBytes()
        }
        return Exchange(status, reason, headers, body, url)
    }

    private fun connect(sock: File): LocalSocket {
        val deadline = System.currentTimeMillis() + CONNECT_MS
        var last: Exception? = null
        while (System.currentTimeMillis() < deadline) {
            if (!sock.exists()) {
                try {
                    Thread.sleep(50L)
                } catch (_: InterruptedException) {
                    break
                }
                continue
            }
            try {
                val local = LocalSocket()
                local.connect(
                    LocalSocketAddress(sock.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM),
                )
                local.soTimeout = IO_TIMEOUT_MS
                return local
            } catch (error: Exception) {
                last = error
                try {
                    Thread.sleep(50L)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }
        throw last ?: IOException("panel.sock not ready")
    }

    private fun applySetCookie(url: String, headers: List<Pair<String, String>>) {
        val cookies = headers.filter { it.first.equals("Set-Cookie", ignoreCase = true) }.map { it.second }
        if (cookies.isEmpty()) return
        val cm = CookieManager.getInstance()
        cookies.forEach { value ->
            cm.setCookie(url, value)
            cm.setCookie(ORIGIN, value)
        }
        cm.flush()
    }

    fun injectBridge(html: String, js: String): String {
        if (html.contains("__levixBridge")) return html
        val tag = "<script>\n$js\n</script>"
        val head = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(html)
        return if (head != null) {
            StringBuilder(html).insert(head.range.last + 1, tag).toString()
        } else {
            tag + html
        }
    }

    private fun fail(detail: String): WebResourceResponse {
        val html = """
            <html><head><meta http-equiv="refresh" content="2"></head>
            <body style="font-family:sans-serif;padding:24px">
            <p>The control panel is not reachable yet.</p>
            <p>${detail.take(180)}</p>
            <p>Retrying automatically. Wait until the host says Levix ready.</p>
            </body></html>
        """.trimIndent()
        return WebResourceResponse(
            "text/html",
            "utf-8",
            502,
            "Bad Gateway",
            mapOf("Content-Type" to "text/html; charset=utf-8"),
            ByteArrayInputStream(html.toByteArray(Charsets.UTF_8)),
        )
    }

    private fun contentType(header: String?): String {
        val raw = header?.substringBefore(';')?.trim()?.lowercase(Locale.US)
        return if (raw.isNullOrBlank()) "application/octet-stream" else raw
    }

    private fun isTextMime(mime: String): Boolean {
        val m = mime.lowercase(Locale.US)
        return m.startsWith("text/") ||
            m == "application/javascript" ||
            m == "application/json" ||
            m == "application/xml" ||
            m == "image/svg+xml"
    }

    private fun charsetOf(header: String?): Charset {
        val match = header?.let { Regex("charset=([^;]+)", RegexOption.IGNORE_CASE).find(it) }
        return try {
            Charset.forName(match?.groupValues?.get(1)?.trim() ?: "UTF-8")
        } catch (_: Exception) {
            Charsets.UTF_8
        }
    }

    private fun pathOf(url: String): String = try {
        URI(url).rawPath ?: "/"
    } catch (_: Exception) {
        url.take(80)
    }

    private fun readLine(input: InputStream): String? {
        val out = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) {
                if (out.size() == 0) return null
                break
            }
            if (b == '\n'.code) break
            if (b != '\r'.code) out.write(b)
            if (out.size() > 64 * 1024) throw IOException("line too long")
        }
        return out.toString(Charsets.ISO_8859_1.name())
    }

    private fun readFully(input: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val got = input.read(buf, off, n - off)
            if (got < 0) break
            off += got
        }
        return if (off == n) buf else buf.copyOf(off)
    }

    private fun readChunked(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        while (true) {
            val line = readLine(input) ?: break
            val size = line.substringBefore(';').trim().toIntOrNull(16) ?: 0
            if (size == 0) {
                while (true) {
                    val trailer = readLine(input) ?: break
                    if (trailer.isEmpty()) break
                }
                break
            }
            out.write(readFully(input, size))
            readLine(input)
        }
        return out.toByteArray()
    }
}
