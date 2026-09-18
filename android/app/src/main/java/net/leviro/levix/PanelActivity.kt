package net.leviro.levix

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.ContactsContract
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.net.URI
import java.nio.charset.StandardCharsets
import org.json.JSONObject

/**
 * Local control panel only. Loads loopback HTTP; Node is reached over the
 * unix socket because this app cannot bind TCP.
 */
class PanelActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var sock: File
    private lateinit var bridgeJs: String

    private val pickPhone = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val uri = result.data?.data.takeIf { result.resultCode == Activity.RESULT_OK }
        deliverPickedContact(uri)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sock = File(HostState.dataDir(this), "panel.sock")
        bridgeJs = try {
            assets.open("panel-bridge.js").use { it.readBytes().toString(StandardCharsets.UTF_8) }
        } catch (error: Exception) {
            HostLog.event("panel bridge asset: ${error.message}")
            ""
        }
        web = WebView(this)
        val container = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#07101f"))
            addView(
                web,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )
        }
        setContentView(container)

        ViewCompat.setOnApplyWindowInsetsListener(container) { v, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(insets.left, insets.top, insets.right, insets.bottom)
            windowInsets
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
        web.setBackgroundColor(Color.parseColor("#07101f"))

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            web.settings.forceDark = WebSettings.FORCE_DARK_OFF
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            web.settings.isAlgorithmicDarkeningAllowed = false
        }

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.addJavascriptInterface(
            PanelBridge(sock, bridgeJs) { runOnUiThread { launchContactPicker() } },
            "LevixHost",
        )

        web.webChromeClient = WebChromeClient()
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
                val url = request.url?.toString() ?: return null
                if (!isLoopback(url)) return blockedResponse()
                return try {
                    PanelHttp.intercept(sock, request, bridgeJs)
                } catch (error: Throwable) {
                    HostLog.event("panel intercept ${error.message}")
                    null
                }
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                HostLog.event("panel loading ${url ?: ""}")
                if (url == null || !isLoopback(url)) {
                    view?.stopLoading()
                    return
                }
                if (!bridgeJs.isEmpty()) {
                    view?.evaluateJavascript(bridgeJs, null)
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (!request.isForMainFrame) return
                HostLog.event("panel webview error ${error.errorCode} ${error.description}")
            }
        }

        val url = loopbackUrl(intent.getStringExtra(EXTRA_URL))
        HostLog.event("panel open $url")
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

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_URL = "url"

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
    }
}
