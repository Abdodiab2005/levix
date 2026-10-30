# The panel page calls PanelBridge through WebView.addJavascriptInterface
# (PanelActivity), by method name. R8 must keep those methods.
-keepclassmembers class net.leviro.levix.PanelBridge {
    @android.webkit.JavascriptInterface <methods>;
}
# WebView checks the annotation at run time, so it must survive too.
-keepattributes RuntimeVisibleAnnotations

# Crash reports carry stack traces and Levix keeps no mapping file, so keep
# class and method names readable. R8 still removes unused code.
-dontobfuscate
