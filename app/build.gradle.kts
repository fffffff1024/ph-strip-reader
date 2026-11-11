plugins {
    id("com.android.application")
}

android {
    namespace = "com.example.phstrip"
    compileSdk = 37
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.example.phstrip"
        minSdk = 24
        targetSdk = 37
        versionCode = 3
        versionName = "1.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // 网页资源直接用 docs 目录，避免两份代码（这个目录同时是 GitHub Pages 的发布目录）
    sourceSets["main"].assets.srcDirs("src/main/assets", "../docs")
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
