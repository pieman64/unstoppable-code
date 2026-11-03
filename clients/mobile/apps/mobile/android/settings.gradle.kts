pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("com.android.built-in-kotlin") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
    // Applies google-services.json (Firebase project config) to the app
    // module at build time; see app/build.gradle.kts and app/google-services.json.example.
    id("com.google.gms.google-services") version "4.4.2" apply false
    // Uploads Crashlytics mapping/symbol files at build time. Applied only
    // alongside google-services (see app/build.gradle.kts) because it is
    // useless — and fails — without a Firebase project config.
    id("com.google.firebase.crashlytics") version "3.0.3" apply false
}

include(":app")
