# 本仓库与上游的差异（Fork 说明）

> 上游：[`dododook/FlowZ`](https://github.com/dododook/FlowZ)（sing-box 内核）
> 本仓库：[`Anji-318/FlowZ-mihomo`](https://github.com/Anji-318/FlowZ-mihomo)（mihomo 内核）
> 原始作者：[`zhangjh/FlowZ`](https://github.com/zhangjh/FlowZ)

本项目是上游 FlowZ 的**派生版本（derivative work）**，遵循上游 MIT 许可，版权声明见 `LICENSE.txt`。
核心改动只有一件事：**把代理内核从 sing-box 换成 mihomo（Clash Meta）**，并保留上游全部 UI 与交互。

---

## 1. 内核与实现差异

| 维度 | 上游（sing-box） | 本仓库（mihomo） |
|---|---|---|
| 内核 | sing-box `1.14.x` | mihomo `1.19.33`（MetaCubeX） |
| 配置格式 | JSON（`inbounds/outbounds/route/dns`） | YAML（`proxies/proxy-groups/rules/dns/tun`） |
| 管理面 | 原生 **gRPC**（StartedService） | **REST + WebSocket**（`external-controller`） |
| 管理面鉴权 | gRPC 通道 + 本地 socket | 仅监听 `127.0.0.1` + 强制 `Bearer` secret（随机生成、持久化） |
| 官方面板 | sing-box dashboard | Clash 系 dashboard（`/dashboard/`） |
| 代码组织 | 生成器直接产 sing-box 结构 | `src/main/services/mihomo/`（4 个文件），`singbox-*.ts` 保留为兼容 shim |

> 迁移策略：新增 `mihomo/` 真实实现，旧的 `singbox-api-client.ts` 等改为 `export { X as Y }` 的 shim，
> 使 7,344 行的 `ProxyManager` 调用面零改动。后续演进见「待办」。

---

## 2. 能力矩阵（唯一真值：`src/shared/core-capabilities.ts`）

| 协议 / 能力 | mihomo 内核 | 说明 |
|---|---|---|
| VLESS / VMess / Trojan | ✅ | 含 Reality、ws/grpc/h2/httpupgrade/xhttp |
| Shadowsocks（含 plugin）/ SOCKS5 / HTTP(S) | ✅ | |
| Hysteria2 / TUIC / AnyTLS | ✅ | |
| WireGuard / WARP | ✅ | WARP 一键注册仍可用 |
| Snell | ⚠️ v4/v5 | **v6 不支持**（sing-box 扩展） |
| NaiveProxy | ❌ | 依赖 sing-box + cronet，mihomo 无实现 |
| SSH 出站 | ❌ | sing-box 专有 |
| Tailscale 组网 | ❌ | sing-box 专有（含登录 / exit node / 反向 mesh） |
| 自定义 outbound JSON | ❌ | sing-box raw-JSON 透传，mihomo 无对应 |

**行为约定**：不支持的协议在「添加/编辑节点」下拉中**置灰并标注原因**；已保存的旧节点不会被删除，
但启用代理时会给出可读错误（不会静默切换到别的节点）。

> 判断逻辑由主进程构建器与渲染端表单**共用同一份** `core-capabilities.ts`，避免「UI 说能用、内核说不能」。

---

## 3. 发布与更新

- **更新源**：`src/shared/repo.ts`（`Anji-318/FlowZ-mihomo`）。此前误指上游，已修正 —— 否则上游发版会把
  本 fork 用户「升级」成 sing-box 版。
- **应用 ID**：`com.flowz.mihomo`；产品名 `FlowZ Mihomo`。与上游包可共存，不再互相覆盖。
- **数据迁移**：首启自动把旧目录（`%APPDATA%/flowz`、`~/Library/Application Support/flowz`）中的
  `config.json` / `privacy-lock.json` / `rules/` / `tailscale/` 等搬到新目录，写 `.migrated-from-flowz` 标记，幂等。
- **完整性**：Release 附带 `SHA256SUMS.txt`；应用内更新校验 GitHub API 的 `asset.digest`（sha256），
  镜像下载同样校验，不符即删包拒绝安装。

---

## 4. 升核流程（维护者）

```bash
# 1) 取官方 release、下载、回填双 sha256、落地 resources/
npm run bump:core -- 1.19.33          # 只升 Android：加 --android

# 2) 用新核校验配置生成（package:* 已内置该门）
npm run verify:config
```

`bump-core.mjs` 做的事：读官方 `asset.digest` → 校验压缩包 → 解压 → 算二进制 sha256 →
写回 `src/shared/core-manifest.json`（`coreArchiveSha256` + `coreBinarySha256`）→ 覆盖 `resources/<平台>/mihomo`。
任何一步不符即中断，不会留下「半新半旧」的 pin 组合。

> 为什么必须写 `coreBinarySha256`：`fetch-core` 用它判断「磁盘上的核是否已过期」。
> 缺这个字段时会退化成「不校验直接跳过」，升核后本地仍跑旧核且无任何告警 —— 这是升核流程里最危险的静默失败。

---

## 4.1 本地打包（国内网络）

`npm run package:win|mac|linux` 会拉 Electron 与 electron-builder 的工具链（nsis / winCodeSign），
直连 GitHub 很慢甚至卡住。建议先设镜像（CI 里已设）：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run package:win
```

另外 `fetch:dashboard` 会拉 ~6.4MB 面板资源（实测 80–100KB/s，约 1 分钟）；`fetch:core` 已 pin 校验，
校验通过时直接 `skip`，不会重复下载。首次打包建议先跑 `npx electron-builder --win --dir`
（只组装目录、不出安装器），能在 1 分钟内验证 asar/extraResources 布局。

## 5. 上游同步策略

当前仓库是**代码快照式**派生（与上游无共同 Git 祖先），无法 `git merge upstream`。建议：

1. 在 GitHub 上 fork 上游，新建分支 `mihomo`，把本仓库代码作为该分支的一次提交；
2. 之后每两周 `git fetch upstream && git merge upstream/main`；
3. 冲突预期集中在 `src/main/services/mihomo/`、5 个 `singbox-*` shim、`ProxyManager.ts`。

已评估但**尚未移植**的上游提交：

| 上游提交 | 内容 | 结论 |
|---|---|---|
| `d169299` #375 | 规则进程选择保持勾选 + macOS UTF-8 路径 | ✅ 已移植（另修正「过滤自身内核」为 mihomo） |
| `6fcb787` #376 | macOS 跟随活动 VPN 路由（proxy/TUN） | ⏸ 暂不移植：核心改动落在 sing-box `route.default_interface`，mihomo 需先做 `interface-name` 映射，且需 macOS 真机验证 |
| `e0902e8` #374 | Windows TUN 起核性能（零 spawn 探活 + 埋点细分） | ⏸ 暂不移植：需 Windows TUN 真机基线，盲移有回归风险 |

---

## 6. 已知限制（诚实清单）

- **官方面板未接线**：上游面板是 sing-box 专用（`dashboard.enabled` + `/dashboard/` + `sing-box-dashboard.*`
  的 localStorage 结构）。mihomo 走的是 `external-ui` + `/ui`（配 metacubexd/yacd），且本项目
  `mihomo-config-builder` 尚未注入 `external-ui`，`fetch:dashboard` 目前仍拉 sing-box 面板。
  → 设置里的「打开面板」在 mihomo 内核下大概率 404，属**未修复项**，下个版本处理（需同时换面板源、
  改 URL 到 `/ui`、改 preload 注入的面板存储格式）。

- macOS 构建未签名/未公证，首次打开需手动移除隔离属性（先核对 `SHA256SUMS.txt`）。
- Windows 未做代码签名，SmartScreen 会提示未知发布者。
- Dashboard 窗口仍是 `contextIsolation: false`（为让 preload 写同源 localStorage），已锁死导航边界，但仍是
  待改造项（目标：contextIsolation + contextBridge 或 header 注入 secret）。
- `ProxyManager.ts` 仍是 7,344 行单体类，拆分计划见仓库 issue/审计报告。
