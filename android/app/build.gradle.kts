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
        versionCode = 53
        versionName = "4.0.2"
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
}
