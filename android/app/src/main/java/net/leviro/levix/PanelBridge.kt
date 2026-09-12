package net.leviro.levix

import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.File

/**
 * fetch / XHR / form POST from the panel page. WebView intercept cannot
 * read POST bodies; those go through this bridge onto the unix socket.
 */
class PanelBridge(private val sock: File, private val bridgeJs: String = "") {
    @JavascriptInterface
    fun request(url: String, method: String, headersJson: String, bodyB64: String): String {
        return try {
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
