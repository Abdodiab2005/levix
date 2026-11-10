package net.leviro.levix

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.provider.ContactsContract
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import net.leviro.levix.billing.BillingHost
import java.io.File
import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Local control panel only. Loads loopback HTTP; Node is reached over the
 * unix socket because this app cannot bind TCP.
 */
class PanelActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var container: FrameLayout
    private lateinit var loadingScreen: FrameLayout
    private lateinit var loadingText: TextView
    private lateinit var sock: File
    private lateinit var bridgeJs: String
    private lateinit var stickerHost: StickerHost
    private lateinit var billingHost: BillingHost
    private val stickerSources = StickerSources()
    private val stickerPickerIds = ArrayDeque<String>()
    private val backupSaveIds = ArrayDeque<String>()
    private val guard = ScreenCaptureGuard { secure -> commitScreenCapture(secure) }

    private val createBackup = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream"),
    ) { uri ->
        val id = backupSaveIds.removeFirstOrNull()
        // The old WebView and host are destroyed on recreation. An orphaned
        // result must still remove the empty document the picker created.
        stickerHost.backupSavePicked(id ?: "", uri)
    }

    private val pickSticker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val id = stickerPickerIds.removeFirstOrNull()
        if (id != null) stickerHost.picked(id, result.data?.data.takeIf { result.resultCode == Activity.RESULT_OK })
    }

    private val pickPhone = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val uri = result.data?.data.takeIf { result.resultCode == Activity.RESULT_OK }
        deliverPickedContact(uri)
    }

    // The panel's settings import reads a file through <input type="file">.
    // A stock WebChromeClient never opens the picker on Android, so the button
    // silently did nothing — this delivers the picked file back to the page.
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val pickFile = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        callback?.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data),
        )
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Before the first frame. A URL cannot tell login from the dashboard.
        guard.start()
        savedInstanceState?.getString(BACKUP_SAVE_ID)?.let { backupSaveIds.addLast(it) }
        applySystemBars()
        sock = File(HostState.dataDir(this), "panel.sock")
        bridgeJs = try {
            assets.open("panel-bridge.js").use { it.readBytes().toString(StandardCharsets.UTF_8) }
        } catch (error: Exception) {
            HostLog.event("panel bridge asset: ${error.message}")
            ""
        }
        web = WebView(this)
        container = FrameLayout(this).apply {
            setBackgroundColor(ContextCompat.getColor(this@PanelActivity, R.color.levix_bg))
            addView(
                web,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )
        }
        setContentView(container)

        // The WebView shows nothing until the panel socket answers, which can
        // take a while when the host is still booting. A small loading screen
        // covers that window so the deep-link never opens on an empty page.
        loadingScreen = FrameLayout(this).apply {
            setBackgroundColor(ContextCompat.getColor(this@PanelActivity, R.color.levix_bg))
            isClickable = true
        }
        val loadingBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
        }
        loadingBox.addView(ProgressBar(this))
        loadingText = TextView(this).apply {
            text = getString(R.string.panel_starting)
            gravity = Gravity.CENTER
            setTextColor(ContextCompat.getColor(this@PanelActivity, R.color.levix_text_muted))
            textSize = 14f
            setPadding(0, dp(14), 0, 0)
        }
        loadingBox.addView(loadingText)
        loadingScreen.addView(
            loadingBox,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER,
            ),
        )
        container.addView(
            loadingScreen,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        // An edge-to-edge window is no longer resized for the keyboard, so the
        // IME inset joins the padding or a focused field in the panel ends up
        // underneath it. Consumed here: the WebView sits inside that padding
        // and must not inset itself a second time.
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime()
            )
            v.setPadding(insets.left, insets.top, insets.right, insets.bottom)
            WindowInsetsCompat.CONSUMED
        }

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.useWideViewPort = true
        web.settings.loadWithOverviewMode = true
        web.settings.textZoom = 100
        web.settings.cacheMode = WebSettings.LOAD_NO_CACHE
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        @Suppress("DEPRECATION")
        web.settings.databaseEnabled = true
        web.settings.displayZoomControls = false
        web.settings.builtInZoomControls = false
        web.settings.setSupportZoom(false)
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.levix_bg))

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            web.settings.forceDark = WebSettings.FORCE_DARK_OFF
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            web.settings.isAlgorithmicDarkeningAllowed = false
        }

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        stickerHost = StickerHost(this, sock, stickerSources,
            { id, result -> runOnUiThread {
                web.evaluateJavascript(
                    "window.__levixHostDone(${JSONObject.quote(id)}, ${result})", null)
            } },
            { id, anyFile -> runOnUiThread {
                stickerPickerIds.addLast(id)
                try {
                    // Sticker Studio only shows images and videos; the
                    // feedback and scheduled-message forms take any file and
                    // the backend validates what it receives.
                    pickSticker.launch(Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        if (!anyFile) {
                            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*"))
                        }
                    })
                } catch (error: Exception) {
                    HostLog.event("sticker picker ${error.message}")
                    stickerPickerIds.remove(id)
                    stickerHost.picked(id, null)
                }
            } },
            { file, mime -> runOnUiThread { shareStickerFile(file, mime) } },
            { id, fileName -> runOnUiThread {
                backupSaveIds.addLast(id)
                try { createBackup.launch(fileName) }
                catch (_: Exception) {
                    backupSaveIds.remove(id)
                    stickerHost.backupSaveFailed(id)
                }
            } },
            { id, bytes, total -> runOnUiThread {
                web.evaluateJavascript(
                    "window.__levixHostProgress(${JSONObject.quote(id)}, $bytes, $total)", null)
            } })
        billingHost = BillingHost(
            this,
            { runOnUiThread {
                web.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent(\"levix-plus-purchase\"))", null)
            } },
            { id, result -> runOnUiThread {
                web.evaluateJavascript(
                    "window.__levixHostDone(${JSONObject.quote(id)}, ${result})", null)
            } },
        )
        web.addJavascriptInterface(
            PanelBridge(
                sock,
                bridgeJs,
                { runOnUiThread { launchContactPicker() } },
                applicationContext,
                { runOnUiThread { HostLogShare.share(this) } },
                { runOnUiThread { finish() } },
                stickerHost,
                { runOnUiThread { pushUiPrefs() } },
                billingHost,
                this,
            ),
            "LevixHost",
        )

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                // One chooser at a time; a stale callback gets null so the
                // page is never left waiting on a dead picker.
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                return try {
                    pickFile.launch(fileChoiceIntent())
                    true
                } catch (error: Exception) {
                    HostLog.event("file chooser ${error.message}")
                    fileChooserCallback = null
                    false
                }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url?.toString() ?: return true
                return !isLoopback(url)
            }

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val url = request.url?.toString()
                if (url == null) {
                    if (request.isForMainFrame) failMainFrame()
                    return null
                }
                if (!isLoopback(url)) {
                    if (request.isForMainFrame) failMainFrame()
                    return blockedResponse()
                }
                if (request.url.path?.startsWith("/__levix-host/source/") == true) {
                    val token = request.url.path!!.removePrefix("/__levix-host/source/")
                    val source = stickerSources.get(token)
                    if (request.method != "GET" || source == null) {
                        if (request.isForMainFrame) failMainFrame()
                        return sourceNotFound()
                    }
                    return try {
                        val input = contentResolver.openInputStream(source.uri.toUri())
                        if (input == null) {
                            if (request.isForMainFrame) failMainFrame()
                            sourceNotFound()
                        } else {
                            WebResourceResponse(source.mime.substringBefore(';'), null, 200, "OK",
                                mapOf("Content-Type" to source.mime, "Cache-Control" to "no-store"), input)
                        }
                    } catch (_: Exception) {
                        if (request.isForMainFrame) failMainFrame()
                        sourceNotFound()
                    }
                }
                return try {
                    val response = PanelHttp.intercept(sock, request, bridgeJs)
                    if (request.isForMainFrame) {
                        // Applies the flag on the main thread and waits before
                        // this response can paint.
                        guard.onMainFrameResponse(url, response.responseHeaders)
                    }
                    response
                } catch (error: Throwable) {
                    HostLog.event("panel intercept ${error.message}")
                    if (request.isForMainFrame) failMainFrame()
                    null
                }
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                HostLog.event("panel loading ${panelLogTarget(url)}")
                // Every start is secure before the next document can paint,
                // including a load this host refuses.
                guard.onPageStarted(url ?: "")
                if (url == null || !isLoopback(url)) {
                    view?.stopLoading()
                    return
                }
                if (!bridgeJs.isEmpty()) {
                    view?.evaluateJavascript(bridgeJs, null)
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                guard.onPageFinished(url ?: "")
                loadingScreen.visibility = View.GONE
                pushUiPrefs()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (!request.isForMainFrame) return
                guard.onMainFrameError()
                HostLog.event("panel webview error ${error.errorCode} ${error.description}")
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) {
                if (!request.isForMainFrame) return
                guard.onMainFrameError()
            }
        }

        val url = loopbackUrl(intent.getStringExtra(EXTRA_URL))
        HostLog.event("panel open ${panelLogTarget(url)}")
        web.loadUrl(url)

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (web.canGoBack()) web.goBack() else finish()
                }
            },
        )
    }

    private fun launchContactPicker() {
        val intent = Intent(Intent.ACTION_PICK).apply {
            type = ContactsContract.CommonDataKinds.Phone.CONTENT_TYPE
        }
        pickPhone.launch(intent)
    }

    /**
     * Any openable file. The panel decides what a given input accepts — the
     * settings import wants JSON, scheduled messages and feedback want media,
     * documents and anything else — so the picker must not pre-filter and
     * silently hide files the page is asking for.
     */
    private fun fileChoiceIntent(): Intent = Intent(Intent.ACTION_GET_CONTENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
    }

    /**
     * Window flags belong on the main thread. [shouldInterceptRequest] runs on
     * a WebView thread and waits, bounded, for the flag update. Already on
     * the main thread: set it and return.
     */
    private fun commitScreenCapture(secure: Boolean) {
        val update = Runnable {
            if (secure) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
        if (Looper.getMainLooper().isCurrentThread) {
            update.run()
            return
        }
        val latch = CountDownLatch(1)
        runOnUiThread {
            try {
                update.run()
            } finally {
                latch.countDown()
            }
        }
        try {
            // The update is queued before the response exists; the WebView can
            // draw the new document only in a later main-thread traversal.
            if (!latch.await(SCREEN_CAPTURE_WAIT_MS, TimeUnit.MILLISECONDS)) {
                HostLog.event("panel screen guard wait timed out")
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun failMainFrame() {
        guard.onMainFrameError()
    }

    /** Scheme, host, port, and path. Query and fragment stay out of the host log. */
    private fun panelLogTarget(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        return try {
            val uri = URI(raw)
            val scheme = uri.scheme ?: return ""
            val host = uri.host ?: return ""
            val port = if (uri.port >= 0) ":${uri.port}" else ""
            "$scheme://$host$port${uri.rawPath ?: ""}"
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * The share sheet for a file Sticker Studio produced. A WebView holds a
     * blob: URL that no other app can open and no chooser can grant, so the
     * bytes are written to the FileProvider's cache and sent from there with a
     * one-shot read grant.
     */
    private fun shareStickerFile(file: File, mime: String) {
        try {
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(send, getString(R.string.panel_share_file)))
        } catch (error: Exception) {
            HostLog.event("panel share sticker ${error.message}")
            Toast.makeText(this, R.string.media_share_failed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun deliverPickedContact(uri: Uri?) {
        if (!::web.isInitialized) return
        val payload = JSONObject()
        if (uri != null) {
            try {
                contentResolver.query(
                    uri,
                    arrayOf(
                        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                        ContactsContract.CommonDataKinds.Phone.NUMBER,
                    ),
                    null,
                    null,
                    null,
                )?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        payload.put("name", cursor.getString(0) ?: "")
                        payload.put("phone", cursor.getString(1) ?: "")
                    }
                }
            } catch (error: Exception) {
                HostLog.event("contact pick ${error.message}")
            }
        }
        val detail = if (payload.has("phone")) payload.toString() else "null"
        web.evaluateJavascript(
            "(function(){window.dispatchEvent(new CustomEvent('levix-contact',{detail:$detail}));})()",
            null,
        )
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun applySystemBars() {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
    }

    private fun repaintNative() {
        val bg = ContextCompat.getColor(this, R.color.levix_bg)
        container.setBackgroundColor(bg)
        loadingScreen.setBackgroundColor(bg)
        loadingText.setTextColor(ContextCompat.getColor(this, R.color.levix_text_muted))
        loadingText.setText(R.string.panel_starting)
        web.setBackgroundColor(bg)
        applySystemBars()
    }

    private fun pushUiPrefs() {
        if (::web.isInitialized) {
            web.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('levix-ui-prefs',{detail:${UiPrefs.json(this)}}))",
                null,
            )
        }
    }

    override fun onResume() {
        super.onResume()
        pushUiPrefs()
        if (::billingHost.isInitialized) billingHost.onResume()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        repaintNative()
        pushUiPrefs()
    }

    override fun onDestroy() {
        if (::billingHost.isInitialized) billingHost.destroy()
        stickerHost.destroy()
        stickerPickerIds.clear()
        backupSaveIds.clear()
        val chooser = fileChooserCallback
        fileChooserCallback = null
        chooser?.onReceiveValue(null)
        web.destroy()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        backupSaveIds.firstOrNull()?.let { outState.putString(BACKUP_SAVE_ID, it) }
        super.onSaveInstanceState(outState)
    }

    companion object {
        const val EXTRA_URL = "url"
        private const val BACKUP_SAVE_ID = "backupSaveCallId"
        private const val SCREEN_CAPTURE_WAIT_MS = 2000L

        /**
         * The one place a panel URL with a screen hash is built, so the app has
         * a single definition of "open the panel on Sticker Studio" (a client
         * route hash, not a server path) and never doubles a slash.
         */
        fun urlForHash(base: String?, hash: String): String {
            val root = base.orEmpty().ifBlank { "http://127.0.0.1:3001/" }
            return root.trimEnd('/') + "/#" + hash
        }

        /**
         * Opens the panel on one of its screens. The hash is a client route
         * ("connection", "stickers"), not a server path.
         *
         * CLEAR_TOP because the panel may already be in the task: with the
         * default launch mode it takes the old instance down and builds a fresh
         * one on the URL below, so a second hand-off never lands on a page
         * still showing the first one's file.
         */
        fun open(context: Context, hash: String) {
            context.startActivity(
                Intent(context, PanelActivity::class.java)
                    .putExtra(EXTRA_URL, urlForHash(HostState.snapshot.panelUrl, hash))
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
            )
        }

        fun loopbackUrl(raw: String?): String {
            val fallback = "http://127.0.0.1:3001/"
            if (raw.isNullOrBlank()) return fallback
            val rewritten = raw.replace("://localhost", "://127.0.0.1")
            return if (isLoopback(rewritten)) rewritten else fallback
        }

        fun isLoopback(url: String): Boolean {
            return try {
                val uri = URI(url)
                val host = uri.host ?: return false
                uri.scheme.equals("http", ignoreCase = true) &&
                    uri.userInfo == null &&
                    (host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1")
            } catch (_: Exception) {
                false
            }
        }

        private fun blockedResponse(): WebResourceResponse = WebResourceResponse(
            "text/plain",
            "utf-8",
            403,
            "Forbidden",
            mapOf("Cache-Control" to "no-store"),
            java.io.ByteArrayInputStream("Blocked by Levix".toByteArray()),
        )

        private fun sourceNotFound(): WebResourceResponse = WebResourceResponse(
            "text/plain", "utf-8", 404, "Not Found",
            mapOf("Cache-Control" to "no-store"),
            java.io.ByteArrayInputStream(ByteArray(0)),
        )
    }
}
