// 顶层构建脚本：只声明插件版本，具体在 app 模块里应用
plugins {
    // AGP 9 起 Kotlin 支持已内置，不再需要单独的 Kotlin 插件
    id("com.android.application") version "9.5.1" apply false
}
