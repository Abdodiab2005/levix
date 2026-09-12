package net.leviro.levix

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.net.URI
import java.nio.charset.StandardCharsets

/**
 * Local control panel only. Loads loopback HTTP; Node is reached over the
 * unix socket because this app cannot bind TCP.
 */
class PanelActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var sock: File
    private lateinit var bridgeJs: String

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
        setContentView(web)

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.useWideViewPort = true
        web.settings.loadWithOverviewMode = true
        web.settings.textZoom = 100
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
        web.addJavascriptInterface(PanelBridge(sock, bridgeJs), "LevixHost")

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
                if (!isLoopback(url)) return null
                return try {
                    PanelHttp.intercept(sock, request, bridgeJs)
                } catch (error: Throwable) {
                    HostLog.event("panel intercept ${error.message}")
                    null
                }
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                HostLog.event("panel loading ${url ?: ""}")
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
                val host = URI(url).host ?: return false
                host == "127.0.0.1" || host == "localhost" || host == "[::1]"
            } catch (_: Exception) {
                false
            }
        }
    }
}
