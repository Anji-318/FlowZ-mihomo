/**
 * mihomo-proxy-builder.ts — ServerConfig → mihomo `proxies[]` 条目映射。
 *
 * 覆盖 FlowZ 全部节点协议到 mihomo（Clash Meta）的字段映射：
 *   vless / vmess / trojan / hysteria2 / tuic / shadowsocks(+plugin) / anytls / snell(v4) /
 *   socks / http / wireguard。
 * 不支持（返回 null + isProtocolSupportedByMihomo 给中文原因）：
 *   naive（依赖 cronet，sing-box 专有）、ssh、tailscale、custom（raw sing-box JSON 透传）、snell v6。
 * TLS/传输层：tls/skip-cert-verify/servername/alpn/client-fingerprint/ech-opts/reality-opts、
 *   ws-opts/grpc-opts/h2-opts/httpupgrade-opts。前置代理链经 `dialer-proxy`。
 * sing-box 专有字段（multiplex、tls.engine、tls.spoof、hy2 bbrProfile/gecko obfs 等）mihomo 无对应，
 * 静默降级不下发（配置构建器统一记 warning）。
 */
import type { ServerConfig } from '../../../shared/types';
import { protocolCapability } from '../../../shared/core-capabilities';

/** mihomo proxy 条目（宽松形状，字段按协议拼装）。 */
export type MihomoProxy = Record<string, unknown>;

/** mihomo 保留/内建出站名，节点名撞上会破坏语义 → 构建期改名规避。 */
const RESERVED_NAMES = new Set([
  'DIRECT',
  'REJECT',
  'GLOBAL',
  'PASS',
  'REJECT-DROP',
  'COMPATIBLE',
]);

/**
 * 节点名 → mihomo 安全名（组/规则引用的唯一键）。
 * 保留可读名（拓扑/日志友好），撞保留名时加前缀规避。去重由调用方（config builder）负责。
 */
export function mihomoSafeName(name: string): string {
  const trimmed = (name || '').trim() || 'proxy';
  return RESERVED_NAMES.has(trimmed.toUpperCase()) ? `node-${trimmed}` : trimmed;
}

/**
 * 节点协议是否被 mihomo 内核支持（不支持时给中文原因，供 UI/日志展示）。
 *
 * 判定表已上提到 `shared/core-capabilities`：渲染端协议选择器要置灰/提示同一套结论，
 * 放在 main 里它拿不到（且会诱发「UI 一份、构建器一份」的漂移）。本函数只做 ServerConfig → 参数适配。
 */
export function mihomoUnsupportedReason(server: ServerConfig): string | null {
  return (
    protocolCapability(server.protocol, { snellVersion: server.snellSettings?.version }).reason ?? null
  );
}

export function isProtocolSupportedByMihomo(server: ServerConfig): boolean {
  return mihomoUnsupportedReason(server) === null;
}

/** TLS 公共块（vless/vmess/trojan/anytls 等）。 */
function applyTls(proxy: MihomoProxy, server: ServerConfig): void {
  const tls = server.tlsSettings;
  const security = server.security;
  const isReality = security === 'reality';
  // vless/vmess：security=tls/reality 才开 TLS；trojan/hysteria2/tuic/anytls 恒 TLS。
  const needTls =
    server.protocol === 'trojan' ||
    server.protocol === 'hysteria2' ||
    server.protocol === 'tuic' ||
    server.protocol === 'anytls' ||
    isReality ||
    security === 'tls';
  if (!needTls) return;

  proxy['tls'] = true;
  const sni = tls?.serverName || server.address;
  if (sni) proxy['servername'] = sni;
  if (tls?.allowInsecure) proxy['skip-cert-verify'] = true;
  if (tls?.alpn && tls.alpn.length > 0) proxy['alpn'] = tls.alpn;
  if (tls?.fingerprint) proxy['client-fingerprint'] = tls.fingerprint;
  if (tls?.ech) {
    proxy['ech-opts'] = { enable: true };
  }
  if (isReality && server.realitySettings?.publicKey) {
    proxy['reality-opts'] = {
      'public-key': server.realitySettings.publicKey,
      ...(server.realitySettings.shortId ? { 'short-id': server.realitySettings.shortId } : {}),
    };
    // reality 必须有 utls 指纹，缺省 chrome（mihomo 要求）
    if (!proxy['client-fingerprint']) proxy['client-fingerprint'] = 'chrome';
  }
}

/** 传输层（ws/grpc/h2/httpupgrade）。 */
function applyTransport(proxy: MihomoProxy, server: ServerConfig): void {
  const network = server.network || 'tcp';
  if (network === 'tcp') return;
  proxy['network'] = network;
  if (network === 'ws') {
    const ws = server.wsSettings;
    const headers: Record<string, string> = { ...(ws?.headers || {}) };
    const opts: Record<string, unknown> = {};
    if (ws?.path) opts['path'] = ws.path;
    if (Object.keys(headers).length > 0) opts['headers'] = headers;
    if (ws?.maxEarlyData && ws.maxEarlyData > 0) {
      opts['max-early-data'] = ws.maxEarlyData;
      if (ws.earlyDataHeaderName) opts['early-data-header-name'] = ws.earlyDataHeaderName;
    }
    if (Object.keys(opts).length > 0) proxy['ws-opts'] = opts;
  } else if (network === 'grpc') {
    const grpc = server.grpcSettings;
    proxy['grpc-opts'] = {
      ...(grpc?.serviceName ? { 'grpc-service-name': grpc.serviceName } : {}),
    };
  } else if (network === 'http') {
    const h = server.httpSettings;
    proxy['h2-opts'] = {
      ...(h?.host && h.host.length > 0 ? { host: h.host } : {}),
      ...(h?.path ? { path: h.path } : {}),
    };
  } else if (network === 'httpupgrade') {
    const h = server.httpSettings;
    proxy['httpupgrade-opts'] = {
      ...(h?.host && h.host.length > 0 ? { host: h.host[0] } : {}),
      ...(h?.path ? { path: h.path } : {}),
    };
  } else if (network === 'xhttp') {
    const x = server.xhttpSettings;
    proxy['xhttp-opts'] = {
      ...(x?.path ? { path: x.path } : {}),
      ...(x?.host ? { host: x.host } : {}),
      ...(x?.mode ? { mode: x.mode } : {}),
      // x-padding-* 等扩展键原样透传（订阅导入收进 extra，跟随 mihomo 演进不在 UI 建模）
      ...(x?.extra || {}),
    };
  }
}

/** hysteria2 端口跳跃："20000:30000"（sing-box 记法）→ "20000-30000"（mihomo 记法）。 */
function hopPorts(serverPorts: string | undefined): string | undefined {
  if (!serverPorts) return undefined;
  return serverPorts.replace(/(\d+)\s*:\s*(\d+)/, '$1-$2');
}

/** shadowsocks plugin-opts："k=v;k2=v2"（sing-box 记法）→ mihomo plugin-opts 对象。 */
function parsePluginOpts(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 构建单个 mihomo proxy 条目。不支持的协议返回 null（reason 见 mihomoUnsupportedReason）。
 * @param detourName 前置代理（链式代理）的 mihomo 名 → `dialer-proxy`。
 */
export function buildMihomoProxy(
  server: ServerConfig,
  name: string,
  detourName?: string
): MihomoProxy | null {
  if (!isProtocolSupportedByMihomo(server)) return null;

  const base: MihomoProxy = {
    name,
    server: server.address,
    port: server.port,
  };
  if (detourName) base['dialer-proxy'] = detourName;

  switch (server.protocol) {
    case 'vless': {
      Object.assign(base, {
        type: 'vless',
        uuid: server.uuid || '',
        udp: true,
      });
      if (server.flow) base['flow'] = server.flow;
      if (server.packetEncoding !== undefined) {
        base['packet-encoding'] = server.packetEncoding || 'none';
      }
      applyTls(base, server);
      applyTransport(base, server);
      break;
    }
    case 'vmess': {
      Object.assign(base, {
        type: 'vmess',
        uuid: server.uuid || '',
        alterId: server.alterId ?? 0,
        cipher: server.vmessSecurity || 'auto',
        udp: true,
      });
      if (server.packetEncoding) base['packet-encoding'] = server.packetEncoding;
      applyTls(base, server);
      applyTransport(base, server);
      break;
    }
    case 'trojan': {
      Object.assign(base, {
        type: 'trojan',
        password: server.password || '',
        udp: true,
      });
      applyTls(base, server);
      applyTransport(base, server);
      break;
    }
    case 'hysteria2': {
      const hy2 = server.hysteria2Settings;
      Object.assign(base, {
        type: 'hysteria2',
        password: server.password || '',
      });
      if (hy2?.upMbps) base['up'] = hy2.upMbps;
      if (hy2?.downMbps) base['down'] = hy2.downMbps;
      if (hy2?.obfs?.type === 'salamander' && hy2.obfs.password) {
        base['obfs'] = 'salamander';
        base['obfs-password'] = hy2.obfs.password;
      }
      const ports = hopPorts(hy2?.serverPorts);
      if (ports) base['ports'] = ports;
      if (hy2?.hopInterval) base['hop-interval'] = parseDurationSeconds(hy2.hopInterval);
      const sni = server.tlsSettings?.serverName || server.address;
      if (sni) base['sni'] = sni;
      if (server.tlsSettings?.allowInsecure) base['skip-cert-verify'] = true;
      if (server.tlsSettings?.alpn?.length) base['alpn'] = server.tlsSettings.alpn;
      if (server.tlsSettings?.fingerprint) base['client-fingerprint'] = server.tlsSettings.fingerprint;
      break;
    }
    case 'tuic': {
      const tuic = server.tuicSettings;
      Object.assign(base, {
        type: 'tuic',
        uuid: server.uuid || '',
        password: server.password || '',
        udp: true,
      });
      if (tuic?.congestionControl) base['congestion-controller'] = tuic.congestionControl;
      if (tuic?.udpRelayMode) base['udp-relay-mode'] = tuic.udpRelayMode;
      if (tuic?.zeroRttHandshake) base['reduce-rtt'] = true;
      if (tuic?.heartbeat) base['heartbeat-interval'] = parseDurationMs(tuic.heartbeat);
      const sni = server.tlsSettings?.serverName || server.address;
      if (sni) base['sni'] = sni;
      if (server.tlsSettings?.allowInsecure) base['skip-cert-verify'] = true;
      if (server.tlsSettings?.alpn?.length) base['alpn'] = server.tlsSettings.alpn;
      break;
    }
    case 'shadowsocks': {
      const ss = server.shadowsocksSettings;
      Object.assign(base, {
        type: 'ss',
        cipher: ss?.method || server.encryption || '',
        password: ss?.password ?? server.password ?? '',
        udp: true,
      });
      if (ss?.plugin) {
        base['plugin'] = ss.plugin;
        const opts = parsePluginOpts(ss.pluginOptions);
        if (opts) base['plugin-opts'] = opts;
      }
      break;
    }
    case 'anytls': {
      const anytls = server.anyTlsSettings;
      Object.assign(base, {
        type: 'anytls',
        password: server.password || '',
        udp: true,
      });
      if (anytls?.idleSessionCheckInterval) {
        base['idle-session-check-interval'] = parseDurationSeconds(anytls.idleSessionCheckInterval);
      }
      if (anytls?.idleSessionTimeout) {
        base['idle-session-timeout'] = parseDurationSeconds(anytls.idleSessionTimeout);
      }
      if (anytls?.minIdleSession !== undefined) base['min-idle-session'] = anytls.minIdleSession;
      const sni = server.tlsSettings?.serverName || server.address;
      if (sni) base['sni'] = sni;
      if (server.tlsSettings?.allowInsecure) base['skip-cert-verify'] = true;
      if (server.tlsSettings?.alpn?.length) base['alpn'] = server.tlsSettings.alpn;
      if (server.tlsSettings?.fingerprint) base['client-fingerprint'] = server.tlsSettings.fingerprint;
      break;
    }
    case 'snell': {
      const snell = server.snellSettings;
      Object.assign(base, {
        type: 'snell',
        psk: server.password || '',
        version: snell?.version ?? 4,
      });
      if (snell?.obfsMode === 'http') {
        base['obfs-opts'] = { mode: 'http', host: snell.obfsHost || 'bing.com' };
      }
      break;
    }
    case 'socks': {
      Object.assign(base, {
        type: 'socks5',
        udp: true,
        ...(server.username ? { username: server.username } : {}),
        ...(server.password ? { password: server.password } : {}),
      });
      if (server.security === 'tls') applyTls(base, server);
      break;
    }
    case 'http': {
      Object.assign(base, {
        type: 'http',
        ...(server.username ? { username: server.username } : {}),
        ...(server.password ? { password: server.password } : {}),
      });
      if (server.security === 'tls') applyTls(base, server);
      break;
    }
    case 'wireguard': {
      const wg = server.wireguardSettings;
      if (!wg) return null;
      const localV4 = wg.localAddress.find((a) => a.includes('.'));
      const localV6 = wg.localAddress.find((a) => a.includes(':'));
      Object.assign(base, {
        type: 'wireguard',
        'private-key': wg.privateKey,
        'public-key': wg.peerPublicKey,
        ...(localV4 ? { ip: localV4 } : {}),
        ...(localV6 ? { ipv6: localV6 } : {}),
        ...(wg.preSharedKey ? { 'pre-shared-key': wg.preSharedKey } : {}),
        ...(wg.reserved && wg.reserved.length > 0 ? { reserved: wg.reserved } : {}),
        mtu: wg.mtu ?? 1408,
        ...(wg.persistentKeepalive ? { 'persistent-keepalive': wg.persistentKeepalive } : {}),
        udp: true,
      });
      break;
    }
    default:
      return null;
  }

  return base;
}

/** "30s" → 30（秒）；解析失败返回 undefined（不下发）。 */
function parseDurationSeconds(raw: string): number | undefined {
  const m = raw.match(/^(\d+(?:\.\d+)?)(s|m|h)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] || 's';
  return Math.round(unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n);
}

/** "10s" → 10000（毫秒，tuic heartbeat-interval）；解析失败返回 undefined。 */
function parseDurationMs(raw: string): number | undefined {
  const sec = parseDurationSeconds(raw);
  return sec === undefined ? undefined : sec * 1000;
}
