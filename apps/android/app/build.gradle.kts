plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "app.monstera.hello"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.monstera.hello"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1"
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    // Pinned to the newest BOM (Compose 1.11.x) that compiles against API 36.
    // BOM 2026.08.00+ (Compose 1.12) requires compileSdk 37. See docs/G0-TOOLCHAIN-REPORT.md.
    implementation(platform("androidx.compose:compose-bom:2026.06.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.12.4")
}
