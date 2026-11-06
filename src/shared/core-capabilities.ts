/**
 * core-capabilities.ts — 当前代理内核（mihomo）对外能力的**单一真值**。
 *
 * 背景（这次审计的核心问题之一）：fork 把内核从 sing-box 换成 mihomo 后，README 仍宣称
 * Tailscale / NaiveProxy / SSH / 自定义 outbound JSON 是「一等协议」，UI 也照样提供完整表单；
 * 但 `mihomo-proxy-builder` 构建时会静默跳过它们，选中时直接抛错。用户按文档配置 → 保存成功 →
 * 启用代理才报错，这是最伤信任的那类失败。
 *
 * 修法：把「能不能用」抽成纯数据，主进程构建器与渲染端表单**共用同一份**判断（渲染端直接 import
 * shared，无需 IPC 往返）。UI 侧据此置灰选项并给出原因，README 的矩阵也照此生成，三处不再漂移。
 *
 * 注意：这里是**协议能力**，不是「用户是否配置了该协议」。已保存的旧节点不会被删除（数据兼容），
 * 只是 UI 明确标注不可用、启动时给出可读错误。
 */

export interface ProtocolCapability {
  /** 当前内核能否构建该协议。 */
  supported: boolean;
  /** 不能时的中文原因（可直接展示给用户）。 */
  reason?: string;
}

/** Snell 版本相关：mihomo 只实现到 v4 的握手，v6 是 sing-box 扩展。 */
const SNELL_MAX_VERSION = 4;

/**
 * 协议 → 能力。键与 `Protocol` 枚举一致；未列出的协议按「支持」处理（新增协议时在此显式表态）。
 */
const CAPABILITIES: Record<string, ProtocolCapability> = {
  vless: { supported: true },
  vmess: { supported: true },
  trojan: { supported: true },
  shadowsocks: { supported: true },
  hysteria2: { supported: true },
  tuic: { supported: true },
  anytls: { supported: true },
  socks: { supported: true },
  http: { supported: true },
  wireguard: { supported: true },
  snell: { supported: true },
  // —— mihomo 无对应实现（sing-box 专有）——
  naive: { supported: false, reason: 'Naive 协议依赖 sing-box + cronet，mihomo 内核不支持' },
  ssh: { supported: false, reason: 'SSH 出站是 sing-box 专有，mihomo 内核不支持' },
  tailscale: { supported: false, reason: 'Tailscale 组网是 sing-box 专有，mihomo 内核不支持' },
  custom: { supported: false, reason: '自定义协议为 sing-box raw-JSON 透传，mihomo 内核不支持' },
};

/** 当前内核标识（用于 UI 文案与诊断包，避免各处硬编码）。 */
export const CORE_KIND = 'mihomo' as const;

/** 判定某协议在当前内核下是否可用；snell 需带版本（v6 不可用）。 */
export function protocolCapability(
  protocol: string,
  opts: { snellVersion?: number } = {}
): ProtocolCapability {
  const base = CAPABILITIES[protocol?.toLowerCase?.() ?? ''] ?? { supported: true };
  if (base.supported && protocol?.toLowerCase?.() === 'snell') {
    const v = opts.snellVersion;
    if (typeof v === 'number' && v > SNELL_MAX_VERSION) {
      return { supported: false, reason: `Snell v${v} 仅 sing-box 支持，mihomo 内核暂不支持（v4 可用）` };
    }
  }
  return base;
}

/** 便捷布尔（调用方只关心能不能用）。 */
export function isProtocolSupportedByCore(
  protocol: string,
  opts: { snellVersion?: number } = {}
): boolean {
  return protocolCapability(protocol, opts).supported;
}

/**
 * 能力矩阵（README / 诊断报告用；顺序即展示顺序）。
 * 与 CAPABILITIES 同源，避免文档另抄一份后漂移。
 */
export const CAPABILITY_MATRIX: Array<{ protocol: string; label: string; capability: ProtocolCapability }> =
  [
    { protocol: 'vless', label: 'VLESS', capability: CAPABILITIES.vless },
    { protocol: 'vmess', label: 'VMess', capability: CAPABILITIES.vmess },
    { protocol: 'trojan', label: 'Trojan', capability: CAPABILITIES.trojan },
    { protocol: 'shadowsocks', label: 'Shadowsocks', capability: CAPABILITIES.shadowsocks },
    { protocol: 'hysteria2', label: 'Hysteria2', capability: CAPABILITIES.hysteria2 },
    { protocol: 'tuic', label: 'TUIC', capability: CAPABILITIES.tuic },
    { protocol: 'anytls', label: 'AnyTLS', capability: CAPABILITIES.anytls },
    { protocol: 'snell', label: 'Snell', capability: CAPABILITIES.snell },
    { protocol: 'socks', label: 'SOCKS5', capability: CAPABILITIES.socks },
    { protocol: 'http', label: 'HTTP(S)', capability: CAPABILITIES.http },
    { protocol: 'wireguard', label: 'WireGuard / WARP', capability: CAPABILITIES.wireguard },
    { protocol: 'naive', label: 'NaiveProxy', capability: CAPABILITIES.naive },
    { protocol: 'ssh', label: 'SSH', capability: CAPABILITIES.ssh },
    { protocol: 'tailscale', label: 'Tailscale', capability: CAPABILITIES.tailscale },
    { protocol: 'custom', label: 'Custom Outbound JSON', capability: CAPABILITIES.custom },
  ];
