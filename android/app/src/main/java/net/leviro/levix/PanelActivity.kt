package net.leviro.levix

import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import java.net.URI

/**
 * Local control panel only. Loads loopback HTTP; nothing off-device.
 */
class PanelActivity : AppCompatActivity() {
    private lateinit var web: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)

        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url?.toString() ?: return true
                if (!isLoopback(url)) return true
                view.loadUrl(url)
                return true
            }
        }

        val url = loopbackUrl(intent.getStringExtra(EXTRA_URL))
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
