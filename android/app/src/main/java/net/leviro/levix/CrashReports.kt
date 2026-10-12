package net.leviro.levix

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.time.ZoneOffset

object CrashReports {
    private const val MAX_PENDING = 20
    private const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
    private const val PREFS = "levix_crash_reports"
    private const val LAST_SEEN = "last_seen_exit"
    private const val LAST_HANDLER = "last_handler_crash"
    private val random = SecureRandom()
    private val timestampFormat = DateTimeFormatterBuilder().appendInstant(3)
        .toFormatter().withZone(ZoneOffset.UTC)
    private val breadcrumbs = ArrayDeque<JSONObject>()
    @Volatile private var resumedScreen: String? = null

    fun directory(context: Context): File = File(HostState.dataDir(context), "crash-reports")

    @Synchronized fun lifecycle(name: String, event: String) {
        val safeName = CrashSanitizer.text("$name.$event", 60)
        breadcrumbs.addLast(JSONObject().put("at", timestampFormat.format(Instant.now()))
            .put("kind", "lifecycle").put("name", safeName))
        while (breadcrumbs.size > 20) breadcrumbs.removeFirst()
        if (event == "resumed") resumedScreen = name.take(40)
        if (event == "paused" && resumedScreen == name) resumedScreen = null
    }

    @Synchronized private fun breadcrumbJson(): JSONArray = JSONArray().also { array ->
        breadcrumbs.forEach { array.put(it) }
    }

    fun pendingFiles(dir: File): List<File> = dir.listFiles()
        ?.filter { it.isFile && Regex("[0-9a-f]{16}\\.json").matches(it.name) }
        ?.sortedWith(compareBy<File> { it.lastModified() }.thenBy { it.name }) ?: emptyList()

    fun sweep(dir: File, now: Long = System.currentTimeMillis()) {
        pendingFiles(dir).filter { it.lastModified() < now - MAX_AGE_MS }.forEach { it.delete() }
        cap(dir)
        dir.listFiles()?.filter { it.name.endsWith(".json.tmp") }?.forEach { it.delete() }
    }

    fun cap(dir: File) {
        val files = pendingFiles(dir)
        files.take((files.size - MAX_PENDING).coerceAtLeast(0)).forEach { it.delete() }
    }

    fun hasPending(context: Context): Boolean = pendingFiles(directory(context)).isNotEmpty()

    fun deleteAll(context: Context) { pendingFiles(directory(context)).forEach { it.delete() } }

    private fun id(): String = ByteArray(8).also(random::nextBytes)
        .joinToString("") { "%02x".format(it) }

    fun reportJson(
        id: String, createdAt: String, category: String, type: String,
        message: String, stack: List<String>, screen: String?, app: Map<String, String>,
        device: Map<String, String>, breadcrumbs: JSONArray,
    ): JSONObject = JSONObject()
        .put("schema", 1)
        .put("id", id)
        .put("fingerprint", CrashSanitizer.fingerprint(category, type, stack))
        .put("createdAt", createdAt)
        .put("category", category)
        .put("error", JSONObject().put("type", type).put("message", message)
            .put("stack", JSONArray(stack)))
        .apply { if (!screen.isNullOrBlank()) put("screen", screen.take(40)) }
        .put("app", JSONObject(app))
        .put("device", JSONObject(device))
        .put("breadcrumbs", breadcrumbs)
        .put("status", "pending")
        .put("lastError", JSONObject.NULL)

    fun write(dir: File, report: JSONObject): Boolean {
        if (!dir.exists() && !dir.mkdirs()) return false
        val id = report.optString("id")
        if (!Regex("[0-9a-f]{16}").matches(id)) return false
        val tmp = File(dir, "$id.json.tmp")
        val dest = File(dir, "$id.json")
        return try {
            FileOutputStream(tmp).use { output ->
                output.write(report.toString().toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            if (!tmp.renameTo(dest)) return false
            cap(dir)
            true
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }

    fun capture(context: Context, category: String, type: String, message: String?,
        frames: List<String>, at: Long = System.currentTimeMillis()): Boolean {
        val dir = directory(context)
        val home = System.getProperty("user.home").orEmpty()
        val dataPath = HostState.dataDir(context).absolutePath
        val safe = { raw: String?, limit: Int -> CrashSanitizer.text(raw, limit, dataPath, home) }
        val safeType = safe(type, 120)
        val safeFrames = frames.take(20).map { safe(it, 200) }
        val app = linkedMapOf("platform" to "android")
        val device = DeviceDiagnostics.collect(context)
        device["nativeApp"]?.takeUnless { it == "unknown" }
            ?.let { app["nativeApp"] = it }
        HostState.snapshot.nodeVersion?.let { app["node"] = safe(it, 32) }
        val report = reportJson(id(), timestampFormat.format(Instant.ofEpochMilli(at)), category, safeType,
            safe(message, 300), safeFrames, resumedScreen, app,
            device, breadcrumbJson())
        return write(dir, report)
    }

    fun captureThrowable(context: Context, error: Throwable) {
        val at = System.currentTimeMillis()
        if (capture(context, "android-crash", error.javaClass.name, error.message,
                error.stackTrace.map(StackTraceElement::toString), at)) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong(LAST_HANDLER, at).commit()
        }
    }

    fun collectHistoricalExits(context: Context) {
        if (Build.VERSION.SDK_INT < 30) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val lastSeen = prefs.getLong(LAST_SEEN, 0L)
        val lastHandler = prefs.getLong(LAST_HANDLER, 0L)
        val manager = context.getSystemService(ActivityManager::class.java) ?: return
        val exits = manager.getHistoricalProcessExitReasons(context.packageName, 0, 0)
            .filter { it.timestamp > lastSeen && it.timestamp >= System.currentTimeMillis() - MAX_AGE_MS }
            .sortedBy { it.timestamp }
        var newest = lastSeen
        for (exit in exits) {
            if (exit.reason == ApplicationExitInfo.REASON_CRASH &&
                kotlin.math.abs(exit.timestamp - lastHandler) <= 5_000L) {
                newest = maxOf(newest, exit.timestamp)
                continue
            }
            val category = when (exit.reason) {
                ApplicationExitInfo.REASON_CRASH -> "android-crash"
                ApplicationExitInfo.REASON_CRASH_NATIVE -> "android-native"
                ApplicationExitInfo.REASON_ANR -> "android-anr"
                else -> {
                    newest = maxOf(newest, exit.timestamp)
                    continue
                }
            }
            if (!capture(context, category, "ApplicationExitInfo", exit.description,
                    emptyList(), exit.timestamp)) break
            newest = maxOf(newest, exit.timestamp)
        }
        if (newest > lastSeen) prefs.edit().putLong(LAST_SEEN, newest).commit()
    }
}
