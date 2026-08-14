# FlowZ 移动端（Android）方案

## 先说结论

**FlowZ 桌面端基于 Electron，Electron 不能运行在 Android/iOS 上**——不存在「打个参数就出 APK」的路径。移动端必须有一个独立的原生壳（shell）。但本次 mihomo 重构为此扫清了最大的障碍：

1. **内核官方支持 Android**。mihomo 每个 release 都发布 4 个 Android ABI 的可执行文件（ELF，interpreter=`/system/bin/linker64`）：`arm64-v8` / `armv7` / `amd64`(x86_64 模拟器) / `386`(x86)。
2. **配置天然跨端**。`src/main/services/mihomo/mihomo-config-builder.ts` 的产物是标准 mihomo YAML，不经任何修改就能喂给 Android 上的 mihomo——桌面端与移动端共用同一份配置语义（节点、规则、DNS、fake-ip、TUN 参数）。
3. **管理 API 跨端一致**。`mihomo-api-client.ts` 走的 REST + WebSocket（`external-controller`）在 Android 上行为完全相同，移动端壳可以照搬同一套管理逻辑（热切换、测速、流量/连接统计）。

## 已落地的基础设施

- `node scripts/fetch-core.mjs --android`（或 `npm run fetch:core:android`）：按 `core-manifest.json` 的 `bundledCoreVersion` 拉取 4 个 Android ABI 内核到 `resources/android-<abi>/mihomo`，与桌面核**同版本、同双 SHA256 pin**（`coreArchiveSha256` / `coreBinarySha256` 的 `android-arm64` / `android-armv7` / `android-x64` / `android-x86` 键）。
- Android 核**不会**被打进桌面安装包（electron-builder 的 extraResources 按目录白名单挑选，只含 win/mac/linux/data/dashboard）。
- 升级内核版本仍只需改 `core-manifest.json` 的 `bundledCoreVersion` 并补齐新 sha pin（Android 与桌面键一起换）。

## 移动端壳的两条路线

### 路线 A（推荐）：Kotlin 壳 + mihomo Android 可执行文件

ClashMetaForAndroid 一系采用的成熟形态：

1. APK 按 ABI 分包（`splits.abi`），把对应 `resources/android-<abi>/mihomo` 作为 asset 打包；
2. 首次启动时把二进制释放到 `context.filesDir`（应用私有目录可执行，`chmod 755`）；
3. `VpnService.Builder` 建立 TUN 接口，把 fd 与 MTU 传给 mihomo（`tun.fd` / `tun.mtu` 配置项，mihomo 支持 Android 的 fd 接管模式）；
4. 通过 `ProcessBuilder` 拉起 `mihomo -d <私有目录> -f <配置>`，用 `external-controller`（127.0.0.1:9090 + secret）走 REST/WS 管理——与桌面端同一套客户端代码逻辑；
5. 配置层复用 FlowZ 的规则/订阅模型，在 Kotlin 侧重写一份精简的 YAML 生成（或直接移植 `mihomo-config-builder.ts` 的逻辑，它没有 Electron 依赖的部分可抽离）。

注意：Android 上不需要（也不能用）桌面端的提权 helper 体系——VpnService 本身就是系统授权的 VPN 入口。

### 路线 B：gomobile AAR

将 mihomo 以 `gomobile bind` 编译为 `.aar`（参考 ClashMetaForAndroid 的 core 模块方式），Kotlin 直接调 Go 导出的 `start/stop` API。优点是进程内调用、生命周期干净；缺点是需要维护 gomobile 编译链。官方 release 不直接发 AAR，需要自建 CI 编译。

### 不建议的方向

- **不要**尝试把 Electron/Cordova/Capacitor 壳跑 mihomo：没有 VPNService 集成，做不了真正的系统代理；
- **不要**在 Android 上跑桌面版 TUN 配置：`route-exclude-address` 等桌面路由细节应由 VpnService 的路由 API 承担，移动端配置生成时需按 fd 接管模式裁剪（`tun` 段改 `fd` 注入）。

## 已交付：Android Studio 工程骨架

**路线 A 已经落地为可构建的工程**：`android-app/`（Kotlin + VpnService + mihomo 二进制子进程），Android Studio 打开即可 `./gradlew assembleDebug` 出 APK。实现要点：

- 内核经 `jniLibs/<abi>/libmihomo.so` trick 随 APK 按 ABI 分发（Gradle `syncMihomoCore` 任务自动从 `resources/android-*` 拷贝）；
- 回环规避用 `addDisallowedApplication(本应用)`（子进程同 UID 自动绕过 VPN），免去跨进程 protect() 的复杂度；
- fd 交接走 mihomo 官方 `tun.file-descriptor` 配置项（`listener/config.Tun.FileDescriptor`，另有 Android 专属 `include-package`/`exclude-package` 可用于分应用代理）；
- 配置生成 `MihomoConfigGen` 与桌面端 `mihomo-config-builder.ts` 同语义（订阅 → proxy-providers + .mrs 规则分流）。

构建方式与当前边界（骨架 UI、release 签名等）见 `android-app/README.md`。后续把桌面端完整 UI 体验搬过来时，管理面对接 REST API（127.0.0.1:9090，协议与 `mihomo-api-client.ts` 一致）即可。
