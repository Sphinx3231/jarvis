plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.roborazzi)
}

val bundledModelFile = "qwen2.5-1.5b-instruct-q8.task"
val bundleModel = (findProperty("jarvis.bundleModel") as String?) == "true"
if (bundleModel) {
    require(rootProject.file("model-assets/$bundledModelFile").isFile) {
        "model-assets/$bundledModelFile is missing: run mobile/scripts/fetch-model.sh first"
    }
}

android {
    namespace = "ai.jarvis.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.jarvis.mobile"
        // Android 12+: hardware-backed key agreement (KeyProperties.PURPOSE_AGREE_KEY) for E2E pairing.
        minSdk = 31
        targetSdk = 35
        versionCode = 1
        versionName = "0.2.0"
        // The on-device model runtime ships native code for 64-bit ARM (every Android 12+ phone).
        ndk { abiFilters += listOf("arm64-v8a") }
        // On-device model bundled into the APK (see mobile/scripts/fetch-model.sh). Only with
        // -Pjarvis.bundleModel=true, so ordinary builds and tests don't pack 1.6 GB.
        buildConfigField("String", "BUNDLED_MODEL", "\"${if (bundleModel) bundledModelFile else ""}\"")
    }
    if (bundleModel) {
        sourceSets["main"].assets.srcDir(rootProject.file("model-assets"))
    }
    // The model must stay uncompressed in the APK so it can be copied out quickly.
    androidResources { noCompress += listOf("task") }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signed with the debug key so `assembleRelease` produces an installable APK out of the box.
            // Replace with your own signing config before distributing.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all { test ->
                // Cross-language integration tests read these (see mobile/scripts/remote-e2e.sh).
                listOf("JARVIS_E2E_PAIRING", "JARVIS_E2E_RELAY", "JARVIS_PROTOCOL_FIXTURES", "JARVIS_PROMPT_DUMP", "JARVIS_MODEL_OUTPUTS").forEach { k ->
                    System.getenv(k)?.let { test.environment(k, it) }
                }
            }
        }
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.datastore.preferences)
    implementation(libs.work.runtime.ktx)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.zxing.android.embedded)
    implementation(libs.mediapipe.genai)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.roborazzi.junit)
}
