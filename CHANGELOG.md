# CHANGELOG

本文件只记录**本 fork（FlowZ Mihomo）**的改动。上游 FlowZ 的变更请见其 Release Notes。

## 4.4.8 — 2026-11-06

首轮「可分发」整备。核心是四件事：**内核升到最新且能持续升**、**更新不再指向 sing-box 版**、
**能力差异对用户可见**、**发布链路能出安装包并自带校验**。

### 内核

- mihomo `1.19.29` → **`1.19.33`**（MetaCubeX 官方 release，2026-10-21）。
- 8 个平台（win / linux / mac-x64 / mac-arm64 / android ×4）的 `coreArchiveSha256` + `coreBinarySha256` 全部重新 pin，
  每个都经官方 `asset.digest` 与解压后二进制双重校验。
- 新增 `npm run bump:core -- <version>`：一条命令完成「取 release → 校验 digest → 解压 → 算二进制 sha →
  写回 manifest → 落地 resources」。支持 `--desktop` / `--android` 分批，`--dry-run` 只看不写。
  （脚本内已处理 Windows 上 GNU tar 不认 zip 的坑：优先 `System32\tar.exe`，再退 `unzip`。）

### 更新链路

- **修正更新源**：`GITHUB_OWNER/REPO` 从上游 `dododook/FlowZ` 改为 `Anji-318/FlowZ-mihomo`。
  此前上游发版会把本 fork 用户「升级」成 sing-box 版，并以相同 appId 覆盖安装。仓库身份收口到
  `src/shared/repo.ts`（`REPO_URL` / `REPO_RELEASES_URL` / `PRODUCT_NAME` / `APP_ID`）。
- **应用更新包新增 sha256 校验**：以 GitHub API 的 `asset.digest` 为锚，下载完成后流式计算 sha256，
  不符即删包拒绝安装（镜像下载同样生效）。此前只校验 content-length。
- **产品隔离**：`appId` → `com.flowz.mihomo`，产品名 → `FlowZ Mihomo`。
- **老用户数据迁移**：首启把旧 `userData`（`flowz`）中的 `config.json` / `privacy-lock.json` / `rules/` /
  `tailscale/` / `skipped_version.txt` 迁到新目录，写 `.migrated-from-flowz` 标记，幂等且不覆盖新数据。

### 协议能力与 UI

- 新增 `src/shared/core-capabilities.ts` 作为能力**单一真值**，主进程构建器与渲染端表单共用。
- 「添加/编辑节点」的协议下拉对 mihomo 不支持的协议（NaiveProxy / SSH / custom）**置灰并标注**；
  编辑命中旧节点时显示原因与后果。此前是「保存成功 → 启用代理才报错」。
- Snell v6 明确提示不可用（mihomo 仅 v4/v5）。
- 进程选择器过滤自身内核时同时识别 `mihomo`（此前只过滤 `sing-box`）。
- 文案清理：dashboard / Snell 版本提示 / 自定义 outbound 说明不再宣称 sing-box 能力。

### 发布工程

- `package:*` / `dist:*` 链路新增 **`verify:config`** 门禁：用真实内核 `mihomo -t -f` 校验生成的
  TUN/系统代理 × 智能/全局/直连三套配置，不通过则不许出包。
- `mihomo-smoke-gen.test.ts` 从 87 行「只生成 YAML」升级为结构断言 + 真内核校验（4 个用例）。
- CI：新增 `ubuntu-latest` leg（发布三平台却只测两平台）、内核缓存、`fetch:core` + `verify:config` 门禁；
  Node 版本改读 `.nvmrc`。
- `release.yml`：产物随附 **`SHA256SUMS.txt`**；`package.yml` 扩展到 Linux 并上传 Windows/Linux 安装包。
- `package.json` 增加 `engines`、`.nvmrc`（26）；`lint-staged` 增加 `eslint --fix`。
- `.gitignore` 补 `resources/*/mihomo`（此前只忽略 `sing-box`，导致 47MB 内核被提交、仓库涨到 125MB、
  clone 基本不可用）。

### 上游同步

- 移植 `#375`（`d169299`）：macOS `ps` 强制 UTF-8 locale，中文路径不再被转义；进程选择器按「完整勾选集合」
  回写，保留未运行进程并支持取消旧选择。
- `#376`（macOS 跟随活动 VPN 路由）与 `#374`（Windows TUN 起核性能）经评估**暂不移植**：前者依赖
  sing-box 的 `route.default_interface`（mihomo 需先做 `interface-name` 映射），后者需 Windows TUN 真机基线。
  详见 `docs/FORK.md`。

### 测试修复（长期红着的 CI）

- `custom-protocol-probe.test.ts`：sing-box 时代遗留（`JSON.parse` 读配置、断言 `outbounds/endpoints`、
  断言「官方核不支持 snell」）。换核后必然失败 → 重写为 mihomo 语义（YAML `proxies[]`、错误原文透传、
  `isEndpoint` 为 no-op）。
- `speed-test.test.ts`：断言默认端点 `http/80`，而代码已是 `https/443` → 断言对齐代码。
- `probeCache` LRU 用例 72s → 1.8s（测试内临时压小上限，避免撞 90s 超时导致 worker 被杀）。
- `release.yml` Linux job 补 Go 工具链（此前只有 mac/win 装 Go，`build:helper` + `REQUIRE_HELPER=1` 必失败）。

### 打包链修复

- `fetch:dashboard.mjs`：解 zip 改用系统 bsdtar 绝对路径（Git Bash 的 GNU tar 不认 zip，报
  `Cannot connect to C: resolve failed`），并改为镜像优先下载。
- 端到端验证：`electron-builder --win` 产出 `FlowZ Mihomo-4.4.8-win-x64-setup.exe` / `-portable.exe`（各 123MB），
  asar 内含 `js-yaml` / `@grpc/grpc-js`，`resources/win/mihomo.exe` 与面板资源齐备，打包版主程序可启动。

### 验证

| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.main.json --noEmit` | 通过 |
| `tsc -p tsconfig.json --noEmit` | 通过 |
| `npm run build` | 通过（renderer 主 chunk 1.75 MB，待拆包） |
| `npm run verify:config` | 通过（mihomo 1.19.33 真核 `-t`，3 套配置 × 321ms） |
| `npm run fetch:core` | 4 桌面平台 `skip (verified)` |
| `eslint` | 0 error / 232 warning（均为 prettier 格式） |

### 仍未做（已知）

- 代码签名：Windows 仍无证书、macOS 仍 ad-hoc（`xattr -cr` 引导已改为「先核对 SHA256SUMS」）。
- Dashboard 窗口 `contextIsolation: false` 未改造（导航边界已锁死）。
- `ProxyManager.ts`（7,344 行）未拆分。
- 备份导出仍为明文（未加密）。
