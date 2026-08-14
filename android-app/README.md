# FlowZ Clash Android（骨架）

FlowZ Clash 的 Android 客户端骨架：**Kotlin + VpnService + mihomo 内核**，可在 Android Studio 中直接打开构建。

## 构建

1. 先在**桌面工程根目录**拉取钉版内核（sha256 校验）：

   ```bash
   npm run fetch:core:android
   ```

   得到 `resources/android-{arm64,armv7,x64,x86}/mihomo`（4 个 ABI）。

2. 用 **Android Studio**（Hedgehog 及以上）打开 `android-app/` 目录，等待 Gradle sync 完成；

   或在 Android Studio 终端 / 任意装好 Android SDK 的终端：

   ```bash
   cd android-app
   ./gradlew assembleDebug        # 首次会生成 gradle wrapper 并下载依赖
   ```

   产物：`app/build/outputs/apk/debug/app-debug.apk`。

   > 仓库不含 `gradle-wrapper.jar`（二进制不入库）：Android Studio 打开时会自动补全；
   > 纯命令行则先 `gradle wrapper` 或直接用 Android Studio 终端。

## 工作原理

```
用户点击启动
  → VpnService.prepare() 申请 VPN 授权（系统弹窗，仅首次）
  → VpnService.Builder 建虚拟网卡（172.19.0.1/30，路由 0.0.0.0/1+128.0.0.0/1）
  → addDisallowedApplication(本应用) —— mihomo 子进程同 UID，上行流量绕过 VPN，防代理回环
  → detachFd() 取网卡 fd，写入配置 tun.file-descriptor
  → exec nativeLibraryDir/libmihomo.so -d <filesDir> -f mihomo_config.yaml
  → 内核接管全部流量；管理面 external-controller 127.0.0.1:9090（secret: flowz-android）
```

关键设计：

- **内核分发 trick**：mihomo 可执行文件以 `libmihomo.so` 名义放入 `jniLibs/<abi>/`（`syncMihomoCore` Gradle 任务自动从桌面工程 `resources/android-*` 拷贝并改名），配合 `extractNativeLibs=true`，安装后落在可执行目录 `nativeLibraryDir`，同时天然按 ABI 分包。
- **`tun.file-descriptor`**：mihomo 官方支持的移动端接法（`listener/config.Tun.FileDescriptor`），内核不自建 TUN（`auto-route=false`），直接读写 VpnService 给的 fd。
- **配置生成**（`MihomoConfigGen`）：输入订阅地址（Clash/mihomo 格式）→ proxy-providers + 自动测速组 + 国内直连分流（.mrs 规则集，与桌面端同源）；输入完整 YAML → 原样使用，仅强制覆盖 `external-controller`/`tun` 接管段。

## 当前边界（骨架≠成品）

- UI 仅一个开关 + 输入框 + 状态日志；节点列表、规则编辑、测速等完整功能需对接 REST API（协议与桌面端 `mihomo-api-client.ts` 一致，可对照移植）
- 订阅须为 Clash/mihomo 格式（YAML proxies）；base64 分享链接订阅需先加一层解析
- 未做分应用代理 UI（mihomo 配置层已支持 `include-package`/`exclude-package`）
- 未做开机自启、Always-on VPN、快速设置磁贴
- release 签名未配置（`assembleRelease` 需自行配置 signingConfigs）

## 目录

```
android-app/
├── settings.gradle.kts / build.gradle.kts / gradle.properties
├── app/build.gradle.kts          # ABI 分包 + syncMihomoCore 内核拷贝任务
└── app/src/main/
    ├── AndroidManifest.xml       # VpnService 声明（BIND_VPN_SERVICE）
    └── java/com/flowz/android/
        ├── MainActivity.kt       # 骨架 UI + VPN 授权流程
        ├── FlowZVpnService.kt    # 虚拟网卡 + 内核进程生命周期
        └── MihomoConfigGen.kt    # 订阅/裸 YAML → 运行配置（注入 tun fd）
```
