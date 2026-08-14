/**
 * mihomo-api-client.ts — mihomo（Clash Meta）external-controller 的 REST + WebSocket 管理客户端。
 *
 * 取代原 sing-box gRPC StartedService 客户端（singbox-api-client.ts），公开表面保持一致：
 * ProxyManager / StatsService / stats-worker 经 singbox-api-client.ts 的兼容 shim 复用本类，
 * 渲染端 IPC 契约（流量/连接/热切换/关闭连接）完全不变 → FlowZ UI 零改动。
 *
 * 映射关系：
 *   · selectOutbound(group, name)        → PUT  /proxies/{group}  {name}
 *   · closeConnection(id)                → DELETE /connections/{id}
 *   · closeAllConnections()              → DELETE /connections
 *   · probe()                            → GET  /version
 *   · subscribeStatus(ns, cb)            → WS /traffic（速率）+ WS /connections（累计）合成 SingBoxStatus
 *   · subscribeConnections(ns, cb)       → WS /connections 全量快照 → {reset:true, events:[NEW...]} 增量帧
 *   · logout / setTailscaleExitNode      → mihomo 无 Tailscale，拒绝桩（UI 保留，后端报不支持）
 *   · onUpdate（Tailscale 状态订阅）     → 永不触发（恒为空）
 */
import http from 'http';

import { isIpv4 } from '../../../shared/ip';
import type { TailscaleStatusPeer } from '../../../shared/tailscale-status';
import { SimpleWebSocket } from './mihomo-ws';

// ---------- 兼容类型（与原 singbox-api-client 同形） ----------

export interface TailscalePeer {
  hostName?: string;
  os?: string;
  tailscaleIPs?: string[];
  online?: boolean;
  exitNode?: boolean;
  exitNodeOption?: boolean;
  active?: boolean;
  keyExpiry?: string;
  stableID?: string;
  expired?: boolean;
}

export type TailscaleSelf = TailscalePeer;

export interface TailscaleUserGroup {
  peers?: TailscalePeer[];
}

export interface TailscaleEndpointStatus {
  endpointTag?: string;
  backendState?: string;
  authURL?: string;
  self?: TailscaleSelf;
  userGroups?: TailscaleUserGroup[];
  peers?: unknown[];
  exitNode?: unknown;
}

/** 摊平 userGroups peers（纯函数，保留原语义供单测复用；mihomo 下恒为空列表输入）。 */
export function flattenTailscalePeers(status: TailscaleEndpointStatus): TailscalePeer[] {
  const seen = new Set<string>();
  const out: TailscalePeer[] = [];
  for (const g of status.userGroups || []) {
    for (const p of g.peers || []) {
      const key = p.stableID || `${p.hostName || ''}|${(p.tailscaleIPs || [])[0] || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

function pickPeerIp(p: { tailscaleIPs?: string[] }): string {
  const ips = p.tailscaleIPs || [];
  return ips.find(isIpv4) || ips[0] || '';
}

/** 摊平 endpoint 状态为 lean peer 列表（纯函数；mihomo 下输入恒空 → 恒返回 []）。 */
export function toTailscaleStatusPeers(ep: TailscaleEndpointStatus): TailscaleStatusPeer[] {
  return flattenTailscalePeers(ep).map((p) => ({
    hostName: p.hostName || '',
    ip: pickPeerIp(p),
    online: p.online === true,
    exitNode: p.exitNode === true,
    exitNodeOption: p.exitNodeOption === true,
    active: p.active === true,
    stableID: p.stableID || undefined,
  }));
}

export interface SingBoxStatus {
  memory?: string;
  goroutines?: number;
  connectionsIn?: number;
  connectionsOut?: number;
  trafficAvailable?: string;
  uplink?: string;
  downlink?: string;
  uplinkTotal?: string;
  downlinkTotal?: string;
}

export interface SingBoxProcessInfo {
  processId?: number;
  userId?: number;
  userName?: string;
  processPath?: string;
  packageNames?: string[];
}

export interface SingBoxConnection {
  id?: string;
  inbound?: string;
  inboundType?: string;
  ipVersion?: number;
  network?: string;
  source?: string;
  destination?: string;
  domain?: string;
  protocol?: string;
  user?: string;
  fromOutbound?: string;
  createdAt?: string;
  closedAt?: string;
  uplink?: string;
  downlink?: string;
  uplinkTotal?: string;
  downlinkTotal?: string;
  rule?: string;
  outbound?: string;
  outboundType?: string;
  chainList?: string[];
  processInfo?: SingBoxProcessInfo;
}

export interface SingBoxConnectionEvent {
  type?: string; // 'NEW' | 'UPDATE' | 'CLOSED'
  id?: string;
  connection?: SingBoxConnection;
  uplinkDelta?: string;
  downlinkDelta?: string;
  closedAt?: string;
}

export interface SingBoxConnectionEvents {
  events?: SingBoxConnectionEvent[];
  reset?: boolean;
}

export interface SingBoxApiTlsOptions {
  ca?: string;
  skipVerify?: boolean;
}

export interface SingBoxApiEndpoint {
  host: string;
  port: number;
  /** mihomo external-controller 不支持 TLS；保留字段仅为端点形状兼容（传 tls 会在调用时抛错）。 */
  tls?: SingBoxApiTlsOptions;
}

// ---------- mihomo REST/WS 载荷形状 ----------

interface MihomoTrafficFrame {
  up: number;
  down: number;
}

interface MihomoConnectionRaw {
  id: string;
  metadata?: {
    network?: string;
    type?: string;
    sourceIP?: string;
    destinationIP?: string;
    sourcePort?: string;
    destinationPort?: string;
    host?: string;
    process?: string;
    processPath?: string;
  };
  upload?: number;
  download?: number;
  start?: string; // RFC3339
  chains?: string[]; // 近端在前，如 ["节点选择","vless-xxx"]
  rule?: string;
  rulePayload?: string;
}

interface MihomoConnectionsFrame {
  downloadTotal?: number;
  uploadTotal?: number;
  connections?: MihomoConnectionRaw[] | null;
}

/** mihomo 连接 → SingBoxConnection（保持渲染端消费形状不变）。 */
export function mapConnection(c: MihomoConnectionRaw): SingBoxConnection {
  const md = c.metadata || {};
  const chainList = Array.isArray(c.chains) ? [...c.chains] : [];
  // chains 近端在前（[selector, node]）；SingBoxConnection.chainList 原语义为节点链，保持原序即可（渲染端只展示）。
  const outbound = chainList[0] || '';
  const createdAtMs = c.start ? Date.parse(c.start) : NaN;
  return {
    id: c.id,
    inbound: md.type || '',
    inboundType: md.type || '',
    network: (md.network || '').toUpperCase(),
    source: md.sourceIP ? `${md.sourceIP}:${md.sourcePort || ''}` : '',
    destination: md.destinationIP
      ? `${md.destinationIP}:${md.destinationPort || ''}`
      : md.host
        ? `${md.host}:${md.destinationPort || ''}`
        : '',
    domain: md.host || '',
    protocol: '',
    createdAt: Number.isFinite(createdAtMs) ? String(createdAtMs * 1_000_000) : '',
    uplinkTotal: String(c.upload ?? 0),
    downlinkTotal: String(c.download ?? 0),
    rule: c.rule ? `${c.rule}${c.rulePayload ? `(${c.rulePayload})` : ''}` : '',
    outbound,
    outboundType: '',
    chainList,
    processInfo:
      md.process || md.processPath
        ? { processPath: md.processPath || md.process || '' }
        : undefined,
  };
}

/**
 * 连 mihomo external-controller（http://127.0.0.1:<port>，Bearer secret）。
 * 公开表面与原 SingBoxApiClient 一致；随主核起停：主核起→start()，主核停→stop()。
 */
export class MihomoApiClient {
  private readonly host: string;
  private readonly port: number;
  private readonly tls?: SingBoxApiTlsOptions;
  private readonly secret: string;
  private readonly onUpdate?: (endpoints: TailscaleEndpointStatus[]) => void;

  constructor(
    endpoint: SingBoxApiEndpoint,
    secret: string,
    onUpdate?: (endpoints: TailscaleEndpointStatus[]) => void
  ) {
    this.host = endpoint.host;
    this.port = endpoint.port;
    this.tls = endpoint.tls;
    this.secret = secret;
    this.onUpdate = onUpdate;
  }

  private baseUrl(): string {
    const host =
      this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host;
    return `http://${host}:${this.port}`;
  }

  private assertNoTls(): void {
    if (this.tls) {
      throw new Error('mihomo external-controller 不支持 TLS 管理端点（远端管理 API 已不可用）');
    }
  }

  /** 通用 REST 请求（Bearer 鉴权），返回 {status, body}。带超时保证必 settle。 */
  private request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 2000
  ): Promise<{ status: number; body: string }> {
    this.assertNoTls();
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        `${this.baseUrl()}${path}`,
        {
          method,
          timeout: timeoutMs,
          headers: {
            ...(this.secret ? { authorization: `Bearer ${this.secret}` } : {}),
            ...(payload !== undefined
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') })
          );
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error('request timeout'));
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** REST 调用并把非 2xx 变为 reject（对齐原 gRPC unary 的错误契约）。 */
  private async call(method: string, path: string, body?: unknown): Promise<void> {
    const { status, body: respBody } = await this.request(method, path, body);
    if (status < 200 || status >= 300) {
      throw new Error(`mihomo api ${method} ${path} → ${status}: ${respBody.slice(0, 200)}`);
    }
  }

  start(): void {
    // mihomo 无 Tailscale 状态流：onUpdate 永不触发（保留字段仅为签名兼容）。
    // 各订阅流（subscribeStatus/subscribeConnections）持独立 stop 句柄，无需类级状态。
    void this.onUpdate;
  }

  stop(): void {
    // 见 start()：无类级资源需清理。
  }

  // ---------- Tailscale：mihomo 不支持，拒绝桩 ----------

  logout(_endpointTag: string): Promise<void> {
    return Promise.reject(new Error('unsupported-mihomo: Tailscale 不可用'));
  }

  setTailscaleExitNode(_endpointTag: string, _stableID: string): Promise<void> {
    return Promise.reject(new Error('unsupported-mihomo: Tailscale 不可用'));
  }

  // ---------- clash 等价管理方法 ----------

  /** 在 selector 组内选定出站（热切换）。groupTag 需 URL 编码。 */
  selectOutbound(groupTag: string, outboundTag: string): Promise<void> {
    return this.call('PUT', `/proxies/${encodeURIComponent(groupTag)}`, { name: outboundTag });
  }

  closeConnection(id: string): Promise<void> {
    return this.call('DELETE', `/connections/${encodeURIComponent(id)}`);
  }

  closeAllConnections(): Promise<void> {
    return this.call('DELETE', '/connections');
  }

  /** 核版本（GET /version → {version, meta, premium}）。 */
  async version(): Promise<string> {
    const { status, body } = await this.request('GET', '/version');
    if (status !== 200) throw new Error(`GET /version → ${status}`);
    try {
      const parsed = JSON.parse(body) as { version?: string };
      return parsed.version || '';
    } catch {
      return '';
    }
  }

  /**
   * 内核原生延迟测试（GET /proxies/{name}/delay?url=&timeout=）：与 FlClash 完全同口径
   * （mihomo URLTest 同一代码路径，unified-delay=false 时剔除建连/握手）。失败/超时返回 null。
   */
  async delay(name: string, url: string, timeoutMs: number): Promise<number | null> {
    const { status, body } = await this.request(
      'GET',
      `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${timeoutMs}`,
      undefined,
      timeoutMs + 2000
    );
    if (status !== 200) return null;
    try {
      const j = JSON.parse(body) as { delay?: number };
      return typeof j?.delay === 'number' && j.delay > 0 ? j.delay : null;
    } catch {
      return null;
    }
  }

  /** 连通探活：GET /version 成功即 ok（鉴权/可达均通过）。 */
  async probe(timeoutMs = 5000): Promise<void> {
    const { status } = await this.request('GET', '/version', undefined, timeoutMs);
    if (status !== 200) throw new Error(`probe → ${status}`);
  }

  // ---------- 订阅流（WS，断线 2s 重连，返回 stop 句柄） ----------

  /**
   * 订阅 Status（流量速率 + 累计）。mihomo 拆成两条流：/traffic 给速率，/connections 给累计，
   * 此处合并为 SingBoxStatus 形状派发（对齐原 SubscribeStatus 语义）。
   */
  subscribeStatus(_intervalNs: number, onStatus: (status: SingBoxStatus) => void): () => void {
    let lastTotals: { up: string; down: string } = { up: '0', down: '0' };
    const stopTraffic = this.subscribeWs<MihomoTrafficFrame>('/traffic', (frame) => {
      onStatus({
        uplink: String(frame.up ?? 0),
        downlink: String(frame.down ?? 0),
        uplinkTotal: lastTotals.up,
        downlinkTotal: lastTotals.down,
      });
    });
    const stopConns = this.subscribeWs<MihomoConnectionsFrame>('/connections', (frame) => {
      lastTotals = {
        up: String(frame.uploadTotal ?? 0),
        down: String(frame.downloadTotal ?? 0),
      };
      onStatus({
        connectionsIn: frame.connections?.length ?? 0,
        uplinkTotal: lastTotals.up,
        downlinkTotal: lastTotals.down,
      });
    });
    return () => {
      stopTraffic();
      stopConns();
    };
  }

  /**
   * 订阅连接事件。mihomo /connections 是周期全量快照（无增量事件），此处转换为
   * {reset:true, events:[{type:'NEW', ...}]} 帧——StatsService 的 connMap 遇 reset 全量重建，
   * 语义与原 gRPC reset 帧一致，连接列表/计数正确。
   */
  subscribeConnections(
    _intervalNs: number,
    onEvents: (events: SingBoxConnectionEvents) => void
  ): () => void {
    return this.subscribeWs<MihomoConnectionsFrame>('/connections', (frame) => {
      const conns = frame.connections || [];
      onEvents({
        reset: true,
        events: conns.map((c) => ({
          type: 'NEW',
          id: c.id,
          connection: mapConnection(c),
        })),
      });
    });
  }

  /** 通用 WS 订阅（自动 JSON 解析 + 2s 断线重连），返回 stop 句柄。 */
  private subscribeWs<T>(path: string, onMsg: (msg: T) => void): () => void {
    let stopped = false;
    let ws: SimpleWebSocket | null = null;
    let retry: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      try {
        ws?.removeAllListeners();
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    };

    const schedule = (): void => {
      if (stopped || retry) return;
      cleanup();
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, 2000);
    };

    const connect = (): void => {
      if (stopped) return;
      try {
        ws = new SimpleWebSocket(`${this.baseUrl()}${path}`, {
          headers: this.secret ? { authorization: `Bearer ${this.secret}` } : {},
        });
        ws.on('message', (text: string) => {
          if (stopped) return;
          try {
            onMsg(JSON.parse(text) as T);
          } catch {
            /* 非 JSON 帧忽略 */
          }
        });
        ws.on('error', () => schedule());
        ws.on('close', () => schedule());
        ws.connect();
      } catch {
        schedule();
      }
    };

    connect();

    return () => {
      stopped = true;
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
      cleanup();
    };
  }
}
