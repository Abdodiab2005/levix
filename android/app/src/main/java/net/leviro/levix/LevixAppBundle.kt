package net.leviro.levix

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * Unpacks the Levix JS tree from the APK into filesDir/app.
 *
 * JS is data (read, not mmap-exec). Native `.node` addons are stripped at
 * stage time because Android 10+ will not dlopen them from writable storage.
 */
object LevixAppBundle {
    private const val ASSET_ZIP = "levix-app.zip"
    private const val STAMP_NAME = ".bundle-version"
    const val BOOT_FILE = "boot.mjs"

    fun dataDir(context: Context): File =
        File(context.applicationContext.filesDir, "data").apply { mkdirs() }

    fun ensure(context: Context): File {
        val app = context.applicationContext
        val dest = File(app.filesDir, "app")
        val version = app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "0"
        val stamp = File(dest, STAMP_NAME)
        val boot = File(dest, BOOT_FILE)
        if (boot.isFile && stamp.isFile && stamp.readText() == version) {
            return dest
        }
        HostLog.event("unpacking Levix app bundle $version")
        if (dest.exists()) dest.deleteRecursively()
        dest.mkdirs()
        unzipAsset(app, dest)
        stamp.writeText(version)
        if (!boot.isFile) {
            throw IllegalStateException("bundle missing $BOOT_FILE")
        }
        HostLog.event("unpacked Levix app bundle")
        return dest
    }

    private fun unzipAsset(context: Context, dest: File) {
        val root = dest.canonicalFile
        context.assets.open(ASSET_ZIP).use { input ->
            ZipInputStream(input).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val out = File(root, entry.name).canonicalFile
                    if (!out.path.startsWith(root.path + File.separator) && out != root) {
                        throw SecurityException("refusing zip entry ${entry.name}")
                    }
                    if (entry.isDirectory) {
                        out.mkdirs()
                    } else {
                        out.parentFile?.mkdirs()
                        FileOutputStream(out).use { zip.copyTo(it) }
                    }
                    zip.closeEntry()
                }
            }
        }
    }
}
