plugins {
    id("com.android.application")
    kotlin("android")
}

// ── 内核来源：桌面工程钉版拉取的 mihomo（../resources/android-<abi>/mihomo，sha256 校验过）。
// 打包 trick：可执行文件以 libmihomo.so 名义放进 jniLibs/<abi>/，APK 安装时系统会把
// native lib 解压到 ApplicationInfo.nativeLibraryDir（可执行权限目录），运行时直接 exec。
// extractNativeLibs=true（见 Manifest）是前提。
val mihomoResourcesDir = rootProject.projectDir.parentFile.resolve("resources")

val syncMihomoCore = tasks.register<Copy>("syncMihomoCore") {
    // 桌面端 resources 键 → Android ABI 目录名
    val abiMap = mapOf(
        "android-arm64" to "arm64-v8a",
        "android-armv7" to "armeabi-v7a",
        "android-x64" to "x86_64",
        "android-x86" to "x86",
    )
    abiMap.forEach { (srcKey, abi) ->
        val src = File(mihomoResourcesDir, "$srcKey/mihomo")
        if (src.exists()) {
            from(src) {
                into("$buildDir/jniLibs/$abi")
                rename { "libmihomo.so" }
            }
        } else {
            logger.warn(
                "mihomo 内核缺失：${src.absolutePath} —— 请先在桌面工程根目录执行 " +
                    "`npm run fetch:core:android` 拉取钉版内核"
            )
        }
    }
}

android {
    namespace = "com.flowz.android"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.flowz.android"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    sourceSets {
        getByName("main") {
            // 由 syncMihomoCore 任务填充（buildDir/jniLibs/<abi>/libmihomo.so）
            jniLibs.srcDir("$buildDir/jniLibs")
        }
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
    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.withType<com.android.build.gradle.tasks.MergeSourceSetFolders>().configureEach {
    dependsOn(syncMihomoCore)
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
