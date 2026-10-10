import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val repoRoot = rootProject.projectDir.parentFile
val cacheDir = System.getenv("LEVIX_NODE_CACHE") ?: "${System.getProperty("user.home")}/.cache/levix-android"
val nodeRuntimeRoot = file("$cacheDir/node-runtime")

// ABIs to package, shared with the fetch script through LEVIX_ANDROID_ABIS
// (default: both). arm64-v8a covers every modern phone; armeabi-v7a covers
// the remaining 32-bit-only devices.
val levixAbis = (System.getenv("LEVIX_ANDROID_ABIS") ?: "arm64-v8a,armeabi-v7a")
    .split(",")
    .map { it.trim() }
    .filter { it.isNotEmpty() }
    .distinct()

val knownAbis = setOf("arm64-v8a", "armeabi-v7a")

// The staged runtime under node-runtime/<abi>/ is only refreshed when someone
// runs fetch-node-android.sh, and jniLibs packages whatever is there — an APK
// once shipped an FFmpeg staged before the recipe gained libwebp, and Sticker
// Studio could not write a sticker. fetch-node-android.sh stamps each runtime
// with the recipes it was built from (runtime_stamp() there); the same stamp is
// recomputed here and a missing or different one fails the build. The file
// name, the inputs and the line format must match RUNTIME_STAMP_FILE /
// RUNTIME_STAMP_INPUTS in the script (tests/android-runtime-stamp.test.mjs).
// The script is deliberately not run from here: it downloads and compiles.
val runtimeStampFile = ".levix-stamp"
val runtimeStampInputs = listOf("build-ffmpeg-android.sh", "fetch-node-android.sh")
val androidScriptsDir = File(repoRoot, "android/scripts")

// The first 16 hex characters of the file's sha256 — `sha256sum | cut -c1-16`.
fun sha256Prefix(file: File): String =
    MessageDigest.getInstance("SHA-256")
        .digest(file.readBytes())
        .joinToString("") { "%02x".format(it) }
        .take(16)

fun expectedRuntimeStamp(abi: String): List<String> =
    listOf("levix-runtime-stamp 1", "abi $abi") +
        runtimeStampInputs.map { "$it ${sha256Prefix(File(androidScriptsDir, it))}" }

// The sticker encoders the panel needs, as the NUL-terminated names FFmpeg
// registers them under. Catches a binary copied in by hand, which no stamp can.
val requiredFfmpegEncoders = listOf("libwebp", "libwebp_anim")

levixAbis.forEach { abi ->
    if (abi !in knownAbis) {
        throw GradleException("Unknown ABI '$abi' in LEVIX_ANDROID_ABIS (supported: $knownAbis)")
    }
    val dir = file("$nodeRuntimeRoot/$abi")
    listOf("libnode.so", "libffmpeg.so").forEach { lib ->
        if (!File(dir, lib).isFile) {
            throw GradleException(
                "Missing $lib for $abi at $dir. Run android/scripts/fetch-node-android.sh first.",
            )
        }
    }

    val refresh = "LEVIX_ANDROID_ABIS=$abi bash android/scripts/fetch-node-android.sh"
    val stamp = File(dir, runtimeStampFile)
    val expected = expectedRuntimeStamp(abi)
    val staged = if (stamp.isFile) stamp.readLines().map { it.trim() }.filter { it.isNotEmpty() } else null
    if (staged != expected) {
        val stale = if (staged == null) {
            listOf("$stamp is missing — staged before runtime stamps existed, by hand, or by an interrupted run")
        } else {
            val have = staged.associate { it.substringBefore(' ') to it.substringAfter(' ', "") }
            expected.mapNotNull { line ->
                val key = line.substringBefore(' ')
                val want = line.substringAfter(' ')
                when (val got = have[key]) {
                    want -> null
                    null -> "$key: not in the staged stamp (repo: $want)"
                    else -> "$key: the stamp says $got, the repository expects $want"
                }
            }.ifEmpty { listOf("$stamp does not match the expected format") }
        }
        throw GradleException(
            "Stale Android runtime for $abi at $dir — it was not staged from the current " +
                "android/scripts/{${runtimeStampInputs.joinToString(",")}}:\n" +
                stale.joinToString("\n") { "  - $it" } +
                "\nRe-stage it from the repository root (Gradle will not run it for you):\n  $refresh",
        )
    }

    val ffmpegBytes = File(dir, "libffmpeg.so").readBytes().toString(Charsets.ISO_8859_1)
    val missingEncoders = requiredFfmpegEncoders.filter { "\u0000$it\u0000" !in ffmpegBytes }
    if (missingEncoders.isNotEmpty()) {
        throw GradleException(
            "Android runtime for $abi has an FFmpeg without the ${missingEncoders.joinToString(", ")} " +
                "encoder(s) at ${File(dir, "libffmpeg.so")} — Sticker Studio cannot write WebP with it. " +
                "Re-stage it from the repository root:\n  $refresh",
        )
    }
}

// Release signing: the upload keystore from the environment when provided
// (what CI uses), otherwise the local debug keystore so a plain
// assembleRelease always yields an installable APK. The same config signs
// the AAB — Google Play rejects unsigned bundles.
val releaseKeystorePath = System.getenv("LEVIX_KEYSTORE_FILE")
val hasCustomKeystore = !releaseKeystorePath.isNullOrBlank() && File(releaseKeystorePath!!).isFile
val debugKeystore = File(System.getProperty("user.home"), ".android/debug.keystore")

android {
    namespace = "net.leviro.levix"
    compileSdk = 36

    defaultConfig {
        applicationId = "net.leviro.levix"
        minSdk = 29
        targetSdk = 36
        versionCode = 63
        versionName = "4.5.0"
    }

    // One APK per ABI — each carries only its own Node runtime, so both
    // artifacts stay ~half the size of a universal build. The AAB keeps
    // every ABI (Google Play generates per-device APKs from it).
    splits {
        abi {
            isEnable = true
            reset()
            include(*levixAbis.toTypedArray())
            isUniversalApk = false
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("src/main/jniLibs", nodeRuntimeRoot)
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    signingConfigs {
        create("levixRelease") {
            if (hasCustomKeystore) {
                storeFile = File(releaseKeystorePath!!)
                storePassword = System.getenv("LEVIX_KEYSTORE_PASSWORD") ?: "android"
                keyAlias = System.getenv("LEVIX_KEY_ALIAS") ?: "androiddebugkey"
                keyPassword = System.getenv("LEVIX_KEY_PASSWORD")
                    ?: System.getenv("LEVIX_KEYSTORE_PASSWORD")
                    ?: "android"
            } else {
                storeFile = debugKeystore
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("levixRelease")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// Publish-friendly artifact names:
//   levix-android-arm64.apk  (arm64-v8a)
//   levix-android-armv7.apk  (armeabi-v7a)
android.applicationVariants.configureEach {
    outputs.all {
        val output = this as com.android.build.gradle.internal.api.BaseVariantOutputImpl
        val abi = output.getFilter(com.android.build.OutputFile.ABI)
        val baseName = when (abi) {
            "arm64-v8a" -> "levix-android-arm64"
            "armeabi-v7a" -> "levix-android-armv7"
            else -> "levix-android"
        }
        output.outputFileName = "$baseName.apk"
    }
}

tasks.register<Exec>("stageLevixApp") {
    workingDir = repoRoot
    commandLine("bash", "android/scripts/stage-levix-app.sh")
    inputs.dir(File(repoRoot, "src"))
    inputs.dir(File(repoRoot, "views"))
    inputs.dir(File(repoRoot, "public"))
    inputs.dir(File(repoRoot, "frontend/src"))
    inputs.file(File(repoRoot, "frontend/package.json"))
    inputs.dir(File(repoRoot, "bin"))
    inputs.file(File(repoRoot, "app.cjs"))
    inputs.file(File(repoRoot, "scheduler.cjs"))
    inputs.file(File(repoRoot, "package.json"))
    inputs.file(File(repoRoot, "android/host-boot.mjs"))
    outputs.file(file("src/main/assets/levix-app.zip"))
}

// Creates the debug keystore on demand so the release signing config always
// has something to sign with when no upload keystore is configured.
tasks.register("ensureDebugKeystore") {
    outputs.file(debugKeystore)
    doLast {
        if (!debugKeystore.isFile) {
            debugKeystore.parentFile?.mkdirs()
            exec {
                // The running JVM's own keytool — PATH on the daemon is not
                // guaranteed to carry it.
                val keytool = File(System.getProperty("java.home"), "bin/keytool")
                commandLine(
                    keytool.absolutePath, "-genkey", "-v",
                    "-keystore", debugKeystore.absolutePath,
                    "-storepass", "android",
                    "-alias", "androiddebugkey",
                    "-keypass", "android",
                    "-keyalg", "RSA",
                    "-keysize", "2048",
                    "-validity", "10000",
                    "-dname", "CN=Android Debug,O=Android,C=US",
                )
            }
        }
    }
}

tasks.named("preBuild").configure {
    dependsOn("stageLevixApp")
    if (!hasCustomKeystore) {
        dependsOn("ensureDebugKeystore")
    }
}

// The Google Play artifact: ./gradlew :app:stageLevixBundle
// -> outputs/bundle/release/levix-android.aab (signed, both ABIs inside).
tasks.register("stageLevixBundle") {
    description = "Build the signed release AAB (levix-android.aab) for Google Play."
    dependsOn("bundleRelease")
    doFirst {
        // Google Play refuses anything signed with the debug certificate, so
        // an AAB built without the upload keystore is never worth producing.
        if (!hasCustomKeystore) {
            throw GradleException(
                "No upload keystore: set LEVIX_KEYSTORE_FILE (and LEVIX_KEYSTORE_PASSWORD, " +
                    "LEVIX_KEY_ALIAS) — Google Play rejects debug-signed bundles.",
            )
        }
    }
    doLast {
        val src = layout.buildDirectory.file("outputs/bundle/release/app-release.aab").get().asFile
        if (!src.isFile) {
            throw GradleException("bundleRelease produced no AAB at $src")
        }
        val dst = File(src.parentFile, "levix-android.aab")
        src.copyTo(dst, overwrite = true)
        logger.lifecycle("Signed AAB ready: $dst")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.viewpager2:viewpager2:1.1.0")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
