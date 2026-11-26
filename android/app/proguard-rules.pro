# Preserve the JavaScript-callable API of the Android WebView bridge.
# The default Android rules cover @JavascriptInterface too; keep the contract
# explicit here without keeping the entire host package or disabling R8.
-keepclassmembers class net.leviro.levix.PanelBridge {
    @android.webkit.JavascriptInterface <methods>;
}
