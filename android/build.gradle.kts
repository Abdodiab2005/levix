plugins {
    // 8.10.x is the first stable line with compileSdk 36 support that still
    // accepts Gradle 8.11.1 (the wrapper version).
    id("com.android.application") version "8.10.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
