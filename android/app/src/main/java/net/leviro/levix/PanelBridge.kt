package net.leviro.levix

import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import net.leviro.levix.billing.BillingHost
import net.leviro.levix.billing.PlusBilling
import org.json.JSONObject
import java.io.File

/**
 * fetch / XHR / form POST from the panel page. WebView intercept cannot
 * read POST bodies; those go through this bridge onto the unix socket.
 *
 * Sticker Studio file operations delegate to StickerHost and return immediately.
 * This class retains the existing synchronous bridge for ordinary panel requests.
 */
class PanelBridge(
    private val sock: File,
    private val bridgeJs: String = "",
    private val onPickContact: (() -> Unit)? = null,
    private val appContext: Context? = null,
    private val onShareLogs: (() -> Unit)? = null,
    private val onClosePanel: (() -> Unit)? = null,
    private val stickerHost: StickerHost? = null,
    private val onUiPrefsChanged: (() -> Unit)? = null,
    private val billingHost: BillingHost? = null,
    private val billingActivity: Activity? = null,
    private val playHost: PlayExperience? = null,
    private val onOpenOfficialLink: ((String) -> Boolean)? = null,
) {
    private fun plusRefusal(callId: String): String? {
        billingHost?.optIn()
        return when {
            BuildConfig.PLUS_PRODUCT_ID.isEmpty() -> PlusBilling.failure("UNAVAILABLE_IN_BUILD").toString()
            !PanelFiles.validCallId(callId) -> PlusBilling.failure("INVALID_INPUT").toString()
            billingHost == null -> PlusBilling.failure("UNAVAILABLE").toString()
            else -> null
        }
    }

    @JavascriptInterface
    fun plusConfigured(): Boolean = BuildConfig.PLUS_PRODUCT_ID.isNotEmpty()

    @JavascriptInterface
    fun plusProduct(callId: String): String = plusRefusal(callId) ?: billingHost!!.productInfo(callId)

    @JavascriptInterface
    fun plusPurchase(callId: String, offerToken: String, installationId: String): String {
        plusRefusal(callId)?.let { return it }
        if (!PlusBilling.validOfferToken(offerToken) || !PlusBilling.validInstallationId(installationId))
            return PlusBilling.failure("INVALID_INPUT").toString()
        val activity = billingActivity ?: return PlusBilling.failure("UNAVAILABLE").toString()
        return billingHost!!.purchase(activity, callId, offerToken, installationId)
    }

    @JavascriptInterface
    fun plusRestore(callId: String): String = plusRefusal(callId) ?: billingHost!!.restore(callId)

    @JavascriptInterface
    fun plusPendingPurchases(callId: String): String = plusRefusal(callId) ?: billingHost!!.pendingPurchases(callId)

    @JavascriptInterface
    fun plusManage(): String {
        billingHost?.optIn()
        if (BuildConfig.PLUS_PRODUCT_ID.isEmpty())
            return PlusBilling.failure("UNAVAILABLE_IN_BUILD").toString()
        return try {
            val context = requireNotNull(appContext)
            val intent = requireNotNull(billingHost?.manageIntent())
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            JSONObject().put("ok", true).toString()
        } catch (_: Exception) {
            PlusBilling.failure("UNAVAILABLE").toString()
        }
    }

    @JavascriptInterface
    fun getInstallChannel(): String = appContext?.let { PlayExperience.installChannel(it) }
        ?: PlayExperience.CHANNEL_GITHUB

    @JavascriptInterface
    fun hasPendingPlayUpdate(): Boolean = appContext?.let { PlayExperience.hasPendingUpdate(it) } ?: false

    /**
     * Leaves the WebView only for a fixed official destination. Validation is
     * synchronous; the activity launches the intent on the UI thread and a
     * missing handler returns false.
     */
    @JavascriptInterface
    fun openOfficialLink(url: String): Boolean = onOpenOfficialLink?.invoke(url) == true

    @JavascriptInterface
    fun getReviewPromptsEnabled(): Boolean =
        appContext?.let { PlayExperience.reviewPromptsEnabled(it) }
            ?: PlayExperience.REVIEW_PROMPTS_DEFAULT

    @JavascriptInterface
    fun setReviewPromptsEnabled(enabled: Boolean): Boolean =
        appContext?.let { PlayExperience.setReviewPromptsEnabled(it, enabled) } ?: false

    @JavascriptInterface
    fun playCheckUpdate(callId: String): String =
        playCall(callId) { host, id -> host.checkUpdate(id) }

    @JavascriptInterface
    fun playStartUpdate(callId: String): String =
        playCall(callId) { host, id -> host.startUpdate(id) }

    @JavascriptInterface
    fun playCompleteUpdate(callId: String): String =
        playCall(callId) { host, id -> host.completeUpdate(id) }

    @JavascriptInterface
    fun playMaybeReview(callId: String): String =
        playCall(callId) { host, id -> host.maybeReview(id) }

    /**
     * A GitHub/self-hosted install must never create or call a Play client,
     * so the channel is checked before the host is reached. The page can call
     * every Play method; a non-Play install gets a plain refusal instead.
     */
    private fun playCall(callId: String, action: (PlayExperience, String) -> String): String {
        if (!PanelFiles.validCallId(callId)) {
            return PlayExperience.failure(PlayExperience.CODE_INVALID_INPUT).toString()
        }
        val context = appContext ?: return PlayExperience.unavailable().toString()
        if (!PlayExperience.installedByPlay(context)) return PlayExperience.unavailable().toString()
        val host = playHost ?: return PlayExperience.unavailable().toString()
        return action(host, callId)
    }

    @JavascriptInterface
    fun getUiPrefs(): String = appContext?.let(UiPrefs::json) ?: "{}"

    @JavascriptInterface
    fun getDiagnostics(): String = appContext?.let(DeviceDiagnostics::json)
        ?: DeviceDiagnostics.UNKNOWN_JSON

    /**
     * Returns true when the request was a real save or an already-equal,
     * valid value, and false when it was rejected (bad value or field). The
     * page may ignore the result; at least a refusal is no longer silent.
     */
    @JavascriptInterface
    fun setUiPrefs(language: String, theme: String, field: String): Boolean {
        val context = appContext ?: return false
        if (!UiPrefs.validLanguage(language) || !UiPrefs.validTheme(theme)) return false
        if (UiPrefs.set(context, language, theme, field)) {
            onUiPrefsChanged?.invoke()
            return true
        }
        // set() returns false both for a refusal and for "no change"; only
        // the latter, with the field itself valid, is a success.
        val noChange = if (field == "language") UiPrefs.language(context) == language
        else field == "theme" && UiPrefs.theme(context) == theme
        return noChange
    }

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

    /** A bridge is also present on the login page, so verify the panel session first. */
    @JavascriptInterface
    fun clearHostLogs(): String {
        return try {
            val context = requireNotNull(appContext)
            val healthUrl = "${PanelHttp.ORIGIN}/dashboard/api/health"
            val health = PanelHttp.exchange(sock, "GET", healthUrl, emptyMap(), ByteArray(0))
            check(health.status == 200 && health.url == healthUrl)
            check(health.header("Content-Type")?.substringBefore(';')?.trim()
                .equals("application/json", ignoreCase = true))
            check(JSONObject(String(health.body, Charsets.UTF_8)).optBoolean("success"))
            HostLog.clear(context)
            JSONObject().put("ok", true).toString()
        } catch (_: Exception) {
            JSONObject().put("ok", false).put("error", "Could not clear host logs").toString()
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

    @JavascriptInterface
    fun takePendingSticker(): String = stickerHost?.takePending()
        ?: JSONObject().put("ok", false).toString()

    @JavascriptInterface
    fun pickStickerSource(callId: String): String = stickerHost?.pick(callId)
        ?: JSONObject().put("ok", false).put("error", "host unavailable").toString()

    /** Any openable file, for the panel forms that upload through [uploadForm]. */
    @JavascriptInterface
    fun pickFile(callId: String): String = stickerHost?.pick(callId, anyFile = true)
        ?: JSONObject().put("ok", false).put("error", "host unavailable").toString()

    @JavascriptInterface
    fun uploadSource(callId: String, token: String, fileName: String, maxBytes: Long): String =
        stickerHost?.upload(callId, token, fileName, maxBytes)
            ?: JSONObject().put("ok", false).put("error", "host unavailable").toString()

    @JavascriptInterface
    fun uploadBackup(callId: String, token: String, maxBytes: Long): String =
        stickerHost?.uploadBackup(callId, token, maxBytes)
            ?: JSONObject().put("ok", false).put("code", "UNAVAILABLE").toString()

    @JavascriptInterface
    fun saveBackup(callId: String, token: String, fileName: String): String =
        stickerHost?.saveBackup(callId, token, fileName)
            ?: JSONObject().put("ok", false).put("code", "UNAVAILABLE").toString()

    /**
     * Native multipart upload for the panel forms (feedback attachment,
     * scheduled-message media): the payload fields ride as text parts and the
     * picked file streams as the "file" part, over the panel's own socket.
     */
    @JavascriptInterface
    fun uploadForm(callId: String, path: String, payloadJson: String, token: String, maxBytes: Long): String =
        stickerHost?.uploadForm(callId, path, payloadJson, token, maxBytes)
            ?: JSONObject().put("ok", false).put("error", "host unavailable").toString()

    @JavascriptInterface
    fun exportFile(callId: String, action: String, path: String, method: String,
        jsonBody: String, fileName: String, mime: String): String =
        stickerHost?.export(callId, action, path, method, jsonBody, fileName, mime)
            ?: JSONObject().put("ok", false).put("error", "host unavailable").toString()

    @JavascriptInterface
    fun cancel(callId: String): String = stickerHost?.cancel(callId)
        ?: JSONObject().put("ok", false).put("error", "host unavailable").toString()

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
