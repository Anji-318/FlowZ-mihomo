# FlowZ：sing-box → Clash Meta / Mihomo 内核重构说明

本次重构将 FlowZ 的代理内核从 sing-box 更换为 **mihomo（Clash Meta）v1.19.29**，渲染层（UI）与 IPC 契约完全未动。

## 验证状态

- `tsc -p tsconfig.main.json --noEmit`：主进程类型检查零错误。
- `vite build`：渲染层构建通过。
- 真实内核冒烟：`buildMihomoConfig` 生成 YAML（vless+reality+ws / trojan / hysteria2 / ss、rule-providers、fake-ip DNS、TUN），经真实 `mihomo -t` 校验通过（见 `src/main/services/__tests__/mihomo-smoke-gen.test.ts`）。
- jest：3433 个测试中 3175 通过；42 个旧测试套件失败，全部是**断言旧 sing-box 配置形状/CLI 的过时测试**（如 `singbox-outbound-builder`、`singbox-dns-builder`、`platform-privilege-service` 断言 `run -c` 等），非运行时缺陷。这些套件需要按 mihomo 语义重写或删除。

## 架构映射

| sing-box 侧 | mihomo 侧 |
|---|---|
| JSON 配置 | YAML（`mihomo_config.yaml`，js-yaml 生成） |
| `run -c config.json` | `-d <userData> -f <config>`；校验 `-t` |
| inbounds (mixed/http) | `mixed-port` + `listeners`（probe/update 入口 + `IN-NAME` 规则） |
| outbounds / route.rules | `proxies` / `rules`（`RULE-SET`/`DOMAIN-*`/`IP-CIDR`/`PROCESS-NAME`/`AND(...)`/`MATCH`） |
| rule_set (.srs) | rule-providers（**.mrs**，zstd 格式；本地文件优先，回退 meta-rules-dat `meta` 分支 URL） |
| dns（sing-box dns 块） | `dns`（nameserver / nameserver-policy `rule-set:` 键 / fake-ip + fake-ip-filter / proxy-server-nameserver） |
| tun inbound | `tun`（stack/mtu/auto-route/strict-route/dns-hijack/route-exclude-address） |
| Clash API gRPC 扩展 | REST + WebSocket：`PUT /proxies/{group}`、`DELETE /connections`、`GET /version`、WS `/traffic` + `/connections` 合成原 `SingBoxStatus`/`SingBoxConnectionEvents`（StatsService 零改动） |
| 日志 JSON | logrus 文本（`time=... level=... msg=...`），解析器已兼容 |

## 关键文件

- `src/main/services/mihomo/mihomo-config-builder.ts` — 配置构建中枢
- `src/main/services/mihomo/mihomo-proxy-builder.ts` — 节点 → mihomo proxy
- `src/main/services/mihomo/mihomo-api-client.ts` — REST/WS 管理客户端（`singbox-api-client.ts` 为兼容 shim）
- `src/main/services/mihomo/mihomo-ws.ts` — 零依赖 RFC 6455 WebSocket 客户端
- `scripts/fetch-core.mjs` / `src/shared/core-manifest.json` — 按版本与双 SHA256 钉死的内核获取
- `resources/data/*.mrs` — 规则集种子（28 个，zstd magic 校验）

## 功能状态

**正常**：订阅节点（vless/vmess/trojan/hysteria2/tuic/shadowsocks/anytls/snell v4/socks/http/wireguard）、TUN、系统代理、自定义规则与应用分流、热切换（组选择契约不变）、主核测速、规则集资源管理、内核更新。

**降级（UI 保留，后端报不支持）**：
- Tailscale / WARP（sing-box endpoint 专有）→ 登录返回 `unsupported-mihomo`，前端 toast 提示
- naive（cronet）、ssh、custom（raw sing-box JSON）、snell v6 → 节点跳过并记 warning
- sing-box 专属字段（multiplex、tls.engine/spoof、hy2 gecko obfs 等）静默降级
- sing-box dashboard（`getDashboardConnectionInfo`）不可用
- cronet 拉取脚本、custom-rule-files 外置规则为遗留死代码，后续可清理

## 构建注意事项

1. `npm install` 后须 `npm install-scripts approve electron-winstaller esbuild protobufjs unrs-resolver`（npm allow-scripts 策略）。
2. `node scripts/gen-build-info.js` 必须在 `tsc` 前运行（生成 `src/shared/build-info.ts`）。
3. Go 辅助程序（helper/helper-win/helper-linux）已改为拉起 `mihomo -d -f`，但**沙箱内无法编译 Go**——发布机上必须执行 `npm run build:helper`。
4. Windows 一键构建：项目根目录 `build.bat`，菜单支持单平台（win/mac/linux）、全部构建、依赖安装、内核拉取。
5. 内核下载走 GitHub release；网络受限时 `scripts/fetch-core.mjs` 内置 gh-proxy 镜像。
