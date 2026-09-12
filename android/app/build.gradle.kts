plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val repoRoot = rootProject.projectDir.parentFile
val cacheDir = System.getenv("LEVIX_NODE_CACHE") ?: "${System.getProperty("user.home")}/.cache/levix-android"
val nodeRuntimeRoot = file("$cacheDir/node-runtime")
val nodeBinary = file("$nodeRuntimeRoot/arm64-v8a/libnode.so")
if (!nodeBinary.isFile) {
    throw GradleException(
        "Missing Node 24 ARM64 runtime at $nodeBinary. Run android/scripts/fetch-node-android.sh first.",
    )
}
val ffmpegBinary = file("$nodeRuntimeRoot/arm64-v8a/libffmpeg.so")
if (!ffmpegBinary.isFile) {
    throw GradleException(
        "Missing FFmpeg ARM64 binary at $ffmpegBinary. Run android/scripts/fetch-node-android.sh first.",
    )
}

android {
    namespace = "net.leviro.levix"
    compileSdk = 35

    defaultConfig {
        applicationId = "net.leviro.levix"
        minSdk = 29
        targetSdk = 35
        versionCode = 24
        versionName = "3.2.1-beta"

        ndk {
            abiFilters += "arm64-v8a"
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

    buildTypes {
        release {
            isMinifyEnabled = false
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

tasks.register<Exec>("stageLevixApp") {
    workingDir = repoRoot
    commandLine("bash", "android/scripts/stage-levix-app.sh")
    inputs.dir(File(repoRoot, "src"))
    inputs.dir(File(repoRoot, "views"))
    inputs.dir(File(repoRoot, "public"))
    inputs.dir(File(repoRoot, "bin"))
    inputs.file(File(repoRoot, "app.cjs"))
    inputs.file(File(repoRoot, "scheduler.cjs"))
    inputs.file(File(repoRoot, "package.json"))
    inputs.file(File(repoRoot, "android/host-boot.mjs"))
    outputs.file(file("src/main/assets/levix-app.zip"))
}

tasks.named("preBuild").configure {
    dependsOn("stageLevixApp")
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
}

fun injectVersionedNativeLibs(destAbiDir: File) {
    val src = file("$nodeRuntimeRoot/arm64-v8a")
    if (!src.isDirectory) return
    destAbiDir.mkdirs()
    src.listFiles()
        ?.filter { it.isFile && it.name.contains(".so.") }
        ?.forEach { it.copyTo(File(destAbiDir, it.name), overwrite = true) }
}

android.applicationVariants.configureEach {
    val variantName = name
    val cap = name.replaceFirstChar { ch -> ch.uppercase() }
    val strip = tasks.named("strip${cap}DebugSymbols")
    strip.configure {
        doLast {
            injectVersionedNativeLibs(
                layout.buildDirectory.get().asFile.resolve(
                    "intermediates/stripped_native_libs/$variantName/strip${cap}DebugSymbols/out/lib/arm64-v8a",
                ),
            )
        }
    }
    tasks.named("package$cap").configure {
        dependsOn(strip)
        doLast {
            val apkDir = layout.buildDirectory.get().asFile.resolve("outputs/apk/$variantName")
            val finalApk = File(apkDir, "app-$variantName.apk")
            val rawApk = finalApk.takeIf { it.isFile }
                ?: File(apkDir, "app-$variantName-unsigned.apk").takeIf { it.isFile }
                ?: return@doLast
            val nativeOut = layout.buildDirectory.get().asFile.resolve(
                "intermediates/stripped_native_libs/$variantName/strip${cap}DebugSymbols/out",
            )
            val abiDir = File(nativeOut, "lib/arm64-v8a")
            val extras = abiDir.listFiles()?.filter { it.name.contains(".so.") }.orEmpty()
            if (extras.isEmpty()) return@doLast
            extras.forEach { lib ->
                val result = exec {
                    workingDir = nativeOut
                    isIgnoreExitValue = true
                    commandLine("zip", "-u", "-X", "-0", rawApk.absolutePath, "lib/arm64-v8a/${lib.name}")
                }
                // 12 = "nothing to do" (entry already current).
                if (result.exitValue != 0 && result.exitValue != 12) {
                    throw GradleException("zip failed (${result.exitValue}) adding ${lib.name}")
                }
            }
            val buildTools = File(System.getenv("ANDROID_HOME") ?: "", "build-tools").listFiles()
                ?.sortedByDescending { it.name }
                ?.firstOrNull()
                ?: throw GradleException("ANDROID_HOME/build-tools not found; cannot re-sign APK")
            val aligned = File(apkDir, "app-$variantName-aligned.apk")
            exec {
                commandLine(File(buildTools, "zipalign").absolutePath, "-f", "-p", "4", rawApk.absolutePath, aligned.absolutePath)
            }
            val releaseKsPath = System.getenv("LEVIX_KEYSTORE_FILE")
            val isCustomReleaseKs = !releaseKsPath.isNullOrBlank() && File(releaseKsPath).isFile
            val ks = if (isCustomReleaseKs) {
                File(releaseKsPath!!)
            } else {
                File(System.getProperty("user.home"), ".android/debug.keystore")
            }
            if (!ks.exists()) {
                ks.parentFile?.mkdirs()
                exec {
                    commandLine(
                        "keytool", "-genkey", "-v",
                        "-keystore", ks.absolutePath,
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
            val ksPass = if (isCustomReleaseKs) (System.getenv("LEVIX_KEYSTORE_PASSWORD") ?: "android") else "android"
            val keyAlias = if (isCustomReleaseKs) (System.getenv("LEVIX_KEY_ALIAS") ?: "androiddebugkey") else "androiddebugkey"
            val keyPass = if (isCustomReleaseKs) (System.getenv("LEVIX_KEY_PASSWORD") ?: ksPass) else "android"

            val ksPassArg = if (ksPass.startsWith("pass:")) ksPass else "pass:$ksPass"
            val keyPassArg = if (keyPass.startsWith("pass:")) keyPass else "pass:$keyPass"

            exec {
                commandLine(
                    File(buildTools, "apksigner").absolutePath,
                    "sign",
                    "--ks", ks.absolutePath,
                    "--ks-pass", ksPassArg,
                    "--ks-key-alias", keyAlias,
                    "--key-pass", keyPassArg,
                    "--in", aligned.absolutePath,
                    "--out", finalApk.absolutePath,
                )
            }
            aligned.delete()
            if (rawApk != finalApk && rawApk.exists()) {
                rawApk.delete()
            }
        }
    }
}
