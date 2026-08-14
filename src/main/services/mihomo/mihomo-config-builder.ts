/**
 * mihomo-config-builder.ts — UserConfig → mihomo（Clash Meta）YAML 配置。
 *
 * 取代 sing-box JSON 配置生成（singbox-*-builder 系列），对外契约保持不变：
 *   · 节点选择组恒名 'proxy-selector'（渲染端热切换/拓扑消费）；
 *   · 指定目标节点的自定义规则生成 'rule-sel-<n>' select 组（热切换经 PUT /proxies/rule-sel-<n>）；
 *   · 主核测速探测池生成 'probe-selector-<k>' 组 + 'probe-in-<k>' listener；
 *   · idToTagMap / ruleSelectors 返回给 ProxyManager 回填 currentIdToTagMap/currentRuleTargetMap。
 *
 * 映射要点：
 *   · mixed inbound          → mixed-port
 *   · clash_api              → external-controller + secret
 *   · smart/global/direct    → mode: rule/global/direct
 *   · TUN inbound            → tun（stack/auto-route/strict-route/dns-hijack/route-exclude-address）
 *   · 国内外 DNS + FakeIP    → dns{nameserver, proxy-server-nameserver, nameserver-policy, fake-ip-filter}
 *   · geosite/geoip/.srs     → rule-providers（本地 .mrs 优先，缺 → MetaCubeX meta 分支 .mrs 远程）
 *   · 多条件 and/or          → AND(...)/多条 OR 行
 * sing-box 专有功能（Tailscale/WARP 注册、naive/cronet、tls_spoof、cache_file 等）无对应，记 warnings 降级。
 */
import path from 'path';

import { getAppPreset } from '../../../shared/app-rules-preset';
import { isDirectSelection } from '../../../shared/direct-selection';
import { DEFAULT_FAKEIP_FILTER_DOMAINS } from '../../../shared/fakeip-filter';
import { localProxyPort, controlApiPort } from '../../../shared/proxy-ports';
import {
  effectiveRegionRouting,
  REGION_FOREIGN_GEO,
  REGION_LOCAL_GEO,
} from '../../../shared/region-routing';
import { isIpCidr, bypassLanCidrs, effectiveBypassLan } from '../../../shared/system-proxy-bypass';
import { resolveTunMtu, resolveTunStack } from '../../../shared/tun-defaults';
import { resolveWinTunInterfaceName } from '../../../shared/tun-interface';
import type { RuleCondition, ServerConfig, UserConfig } from '../../../shared/types';
import { getRuleSetRuntimeDir } from '../builtin-geo-rulesets';
import { getUserDataPath } from '../../utils/paths';
import {
  buildMihomoProxy,
  isProtocolSupportedByMihomo,
  mihomoSafeName,
  mihomoUnsupportedReason,
  type MihomoProxy,
} from './mihomo-proxy-builder';

export interface MihomoBuildDeps {
  /** 启动前校验 gate 判废的节点 tag 集（跳过，不进 proxies/组）。 */
  gateInvalidNodes: Set<string>;
  /** 主核测速/更新 listener 端口（0 = 不注入）。 */
  probeDirectPort: number;
  probeProxyPort: number;
  updateInPort: number;
  /** 主核测速探测池端口（空 = 不注入）。 */
  probePoolPorts: number[];
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface MihomoBuildResult {
  config: Record<string, unknown>;
  /** serverId → mihomo 节点名（组/规则引用键）。 */
  idToTagMap: Map<string, string>;
  /** ruleKey（custom:<ruleId> / app:<appId>）→ {selectorTag, memberTag}（热切换目标）。 */
  ruleSelectors: Map<string, { selectorTag: string; memberTag: string }>;
  warnings: string[];
}

/** mihomo 工作目录（-d）：缓存/规则集相对路径的基准。 */
export function getMihomoWorkDir(): string {
  return getUserDataPath();
}

/** meta-rules-dat 的 mihomo(mrs) 分支 raw 前缀。 */
const MRS_REMOTE_BASE = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo';

/** geosite 值（如 'cn' / 'category-ir'）→ rule-provider 名（'geosite-cn'）。 */
function geositeProviderName(value: string): string {
  return value.startsWith('geosite-') ? value : `geosite-${value}`;
}
function geoipProviderName(value: string): string {
  return value.startsWith('geoip-') ? value : `geoip-${value}`;
}

/** mihomo fake-ip-filter 条目归一化：纯域名 → '+.domain'（后缀语义，对齐 sing-box domain_suffix 清单）。 */
function fakeIpFilterEntry(entry: string): string {
  const e = entry.trim();
  if (!e) return e;
  if (e === 'lan' || e === 'localhost' || e.startsWith('+') || e.startsWith('*')) return e;
  if (e.startsWith('.')) return `+${e}`;
  if (/^[A-Za-z0-9.-]+$/.test(e) && e.includes('.')) return `+.${e}`;
  return e;
}

export function buildMihomoConfig(config: UserConfig, deps: MihomoBuildDeps): MihomoBuildResult {
  const warnings: string[] = [];
  const warn = (msg: string): void => {
    warnings.push(msg);
    deps.log('warn', `[mihomo] ${msg}`);
  };

  // ---------- 节点 → proxies + idToTagMap ----------
  const idToTagMap = new Map<string, string>();
  const usedNames = new Set<string>();
  const proxies: MihomoProxy[] = [];
  const usableServers: ServerConfig[] = [];

  for (const server of config.servers || []) {
    if (!isProtocolSupportedByMihomo(server)) {
      warn(`节点「${server.name}」已跳过：${mihomoUnsupportedReason(server)}`);
      continue;
    }
    let name = mihomoSafeName(server.name);
    let n = 2;
    while (usedNames.has(name)) name = `${mihomoSafeName(server.name)} (${n++})`;
    if (deps.gateInvalidNodes.has(name)) continue;
    usedNames.add(name);
    idToTagMap.set(server.id, name);
    usableServers.push(server);
  }

  // 第二遍构建（detour 依赖 idToTagMap 全量就绪）
  for (const server of usableServers) {
    const name = idToTagMap.get(server.id)!;
    const detourName = server.detour ? idToTagMap.get(server.detour) : undefined;
    if (server.detour && !detourName) {
      warn(`节点「${server.name}」的前置代理已不可用，按直连构建`);
    }
    const proxy = buildMihomoProxy(server, name, detourName);
    if (proxy) proxies.push(proxy);
  }

  const nodeNames = proxies.map((p) => String(p['name']));

  // ---------- 组 ----------
  const isDirect = isDirectSelection(config.selectedServerId);
  const selectedName =
    !isDirect && config.selectedServerId ? idToTagMap.get(config.selectedServerId) : undefined;
  if (!isDirect && !selectedName) {
    throw new Error('Selected server not found');
  }

  const groups: Record<string, unknown>[] = [];
  const proxySelectorMembers = nodeNames.length > 0 ? [...nodeNames, 'DIRECT'] : ['DIRECT'];
  groups.push({
    name: 'proxy-selector',
    type: 'select',
    proxies: proxySelectorMembers,
  });
  // select 组默认选中第一项：把选中节点排到首位（热切换前即生效）
  if (selectedName) {
    const g = groups[0] as { proxies: string[] };
    g.proxies = [selectedName, ...g.proxies.filter((p) => p !== selectedName)];
  }

  // 规则目标组（rule-sel-<n>）：action=proxy + targetServerId 的规则 / 应用规则
  const ruleSelectors = new Map<string, { selectorTag: string; memberTag: string }>();
  const ruleSelTargets = new Map<string, string>(); // groupName → nodeName
  const ensureRuleSelector = (refId: string, targetServerId: string): string | null => {
    const targetName = idToTagMap.get(targetServerId);
    if (!targetName) return null;
    const existing = ruleSelectors.get(refId);
    if (existing) return existing.selectorTag;
    const groupName = `rule-sel-${ruleSelectors.size + 1}`;
    ruleSelectors.set(refId, { selectorTag: groupName, memberTag: targetName });
    ruleSelTargets.set(groupName, targetName);
    return groupName;
  };

  // ---------- listeners（主核测速/更新借道）+ IN-NAME 规则 ----------
  const listeners: Record<string, unknown>[] = [];
  const inNameRules: string[] = [];
  const addListener = (name: string, port: number, target: string): void => {
    if (!port || port <= 0) return;
    listeners.push({ name, type: 'http', port, listen: '127.0.0.1' });
    inNameRules.push(`IN-NAME,${name},${target}`);
  };
  addListener('probe-direct-in', deps.probeDirectPort, 'DIRECT');
  addListener('probe-proxy-in', deps.probeProxyPort, 'proxy-selector');
  addListener('update-in', deps.updateInPort, 'proxy-selector');
  deps.probePoolPorts.forEach((port, k) => {
    if (!port || port <= 0) return;
    const groupName = `probe-selector-${k + 1}`;
    groups.push({
      name: groupName,
      type: 'select',
      proxies: nodeNames.length > 0 ? nodeNames : ['DIRECT'],
    });
    addListener(`probe-in-${k + 1}`, port, groupName);
  });

  // ---------- 规则 ----------
  const rules: string[] = [...inNameRules];
  const usedProviders = new Map<string, { category: 'geosite' | 'geoip'; value: string }>();
  const remoteProviders = new Map<string, string>(); // name → url（res:URL 自定义规则集）

  const registerGeoProvider = (category: 'geosite' | 'geoip', value: string): string => {
    const name = category === 'geosite' ? geositeProviderName(value) : geoipProviderName(value);
    if (!usedProviders.has(name)) usedProviders.set(name, { category, value });
    return name;
  };

  /** 单条件 → mihomo 规则行前缀列表（每个 value 一行；null = 不支持，记 warning）。 */
  const conditionToMihomo = (cond: RuleCondition): string[] | null => {
    const out: string[] = [];
    for (const raw of cond.values || []) {
      const v = String(raw).trim();
      if (!v) continue;
      switch (cond.type) {
        case 'domain':
          out.push(`DOMAIN,${v}`);
          break;
        case 'domainSuffix':
          out.push(`DOMAIN-SUFFIX,${v}`);
          break;
        case 'domainKeyword':
          out.push(`DOMAIN-KEYWORD,${v}`);
          break;
        case 'domainRegex':
          out.push(`DOMAIN-REGEX,${v}`);
          break;
        case 'ipCidr':
          out.push(`${v.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${v},no-resolve`);
          break;
        case 'sourceIpCidr':
          out.push(`SRC-IP-CIDR,${v}`);
          break;
        case 'port':
          out.push(`DST-PORT,${v}`);
          break;
        case 'sourcePort':
          out.push(`SRC-PORT,${v}`);
          break;
        case 'processName':
          out.push(`PROCESS-NAME,${v}`);
          break;
        case 'processPath':
          out.push(`PROCESS-PATH,${v}`);
          break;
        case 'geosite':
          out.push(`RULE-SET,${registerGeoProvider('geosite', v)}`);
          break;
        case 'geoip':
          out.push(`RULE-SET,${registerGeoProvider('geoip', v)}`);
          break;
        case 'ruleSet': {
          // res:<resourceId>（内置/已下载资源）或 URL
          if (v.startsWith('res:')) {
            const resId = v.slice(4);
            const tag = resId.startsWith('builtin:') ? resId.slice('builtin:'.length) : resId;
            // 内置/本地资源 tag 形如 geosite-xxx / geoip-xxx
            const category = tag.startsWith('geoip-') ? 'geoip' : 'geosite';
            const value = tag.replace(/^geo(site|ip)-/, '');
            out.push(`RULE-SET,${registerGeoProvider(category, value)}`);
          } else if (/^https?:\/\//.test(v)) {
            const name = `custom-${remoteProviders.size + 1}`;
            remoteProviders.set(name, v);
            out.push(`RULE-SET,${name}`);
          } else {
            warn(`规则集引用「${v}」无法识别（非 res:/URL），已跳过`);
          }
          break;
        }
        case 'sourceMac':
        case 'sourceHostname':
          warn(`规则条件 ${cond.type}（源设备识别）mihomo 不支持，已跳过值「${v}」`);
          break;
        default:
          warn(`规则条件 ${cond.type} 无法映射到 mihomo，已跳过值「${v}」`);
      }
    }
    return out.length > 0 ? out : null;
  };

  const ruleTarget = (
    action: 'proxy' | 'direct' | 'block',
    refId: string,
    targetServerId?: string
  ): string => {
    if (action === 'direct') return 'DIRECT';
    if (action === 'block') return 'REJECT';
    if (targetServerId) {
      const sel = ensureRuleSelector(refId, targetServerId);
      if (sel) return sel;
      warn(`规则目标节点不可用（${refId}），回退全局出口`);
    }
    return 'proxy-selector';
  };

  // 自定义规则
  for (const rule of config.customRules || []) {
    if (!rule.enabled) continue;
    if (rule.tlsSpoof) {
      warn(`规则「${rule.remarks || rule.id}」的 TLS spoof 为 sing-box 专有，mihomo 下不生效`);
    }
    const target = ruleTarget(rule.action, `custom:${rule.id}`, rule.targetServerId);
    const conds =
      rule.conditions && rule.conditions.length > 0
        ? rule.conditions
        : [{ type: rule.type, values: rule.values }];
    const mapped = conds.map((c) => conditionToMihomo(c));
    if (mapped.some((m) => !m)) continue;

    if (conds.length > 1 && rule.combineMode === 'and') {
      // AND：仅当每个条件都单值单行时可组合
      if (mapped.every((m) => m!.length === 1)) {
        // AND,(cond1),(cond2),target
        rules.push(`AND,(${mapped.map((m) => m![0]).join('),(')}),${target}`);
      } else {
        warn(`规则「${rule.remarks || rule.id}」多值条件无法 AND 组合，已退化为 OR`);
        for (const m of mapped) for (const line of m!) rules.push(`${line},${target}`);
      }
    } else {
      for (const m of mapped) for (const line of m!) rules.push(`${line},${target}`);
    }
  }

  // 应用分流
  if (config.appRoutingEnabled !== false) {
    for (const appRule of config.appRules || []) {
      if (!appRule.enabled) continue;
      const preset = getAppPreset(appRule.appId, config.customAppPresets || []);
      if (!preset) continue;
      const target = ruleTarget(appRule.action, `app:${appRule.appId}`, appRule.targetServerId);
      for (const p of preset.processNames || []) rules.push(`PROCESS-NAME,${p},${target}`);
      for (const g of preset.geositeTags || []) {
        rules.push(`RULE-SET,${registerGeoProvider('geosite', g)},${target}`);
      }
      for (const g of preset.geoipTags || []) {
        rules.push(`RULE-SET,${registerGeoProvider('geoip', g)},${target}`);
      }
    }
  }

  // WireGuard 组网：内网段恒路由（alwaysRouteSubnets 缺省 true）
  for (const server of usableServers) {
    if (server.protocol !== 'wireguard') continue;
    const wg = server.wireguardSettings;
    if (!wg || wg.alwaysRouteSubnets === false) continue;
    const name = idToTagMap.get(server.id)!;
    for (const cidr of wg.allowedIPs || []) {
      if (cidr === '0.0.0.0/0' || cidr === '::/0') continue;
      rules.push(
        `${cidr.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${cidr},${name},no-resolve`
      );
    }
  }

  // 绕过局域网（CIDR → DIRECT）
  if (config.bypassLAN !== false) {
    for (const cidr of bypassLanCidrs(effectiveBypassLan(config))) {
      rules.push(
        `${cidr.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${cidr},DIRECT,no-resolve`
      );
    }
  }

  // 阻止 QUIC
  if (config.blockQuic) {
    rules.push('AND,(NETWORK,UDP),(DST-PORT,443),REJECT');
  }

  // 地区分流（仅 smart 模式）
  const mode = config.proxyMode === 'global' ? 'global' : config.proxyMode === 'direct' ? 'direct' : 'rule';
  if (mode === 'rule') {
    const rr = effectiveRegionRouting(config);
    if (rr.enabled) {
      const local = REGION_LOCAL_GEO[rr.region];
      const foreign = REGION_FOREIGN_GEO[rr.region];
      if (local) {
        const localTarget = rr.reverse ? 'proxy-selector' : 'DIRECT';
        for (const t of local.geosite) rules.push(`RULE-SET,${registerGeoProvider('geosite', t.replace(/^geosite-/, ''))},${localTarget}`);
        for (const t of local.geoip) rules.push(`RULE-SET,${registerGeoProvider('geoip', t.replace(/^geoip-/, ''))},${localTarget}`);
      }
      if (foreign && !rr.reverse) {
        for (const t of foreign.geosite) rules.push(`RULE-SET,${registerGeoProvider('geosite', t.replace(/^geosite-/, ''))},proxy-selector`);
      }
      rules.push(`MATCH,${rr.reverse ? 'DIRECT' : 'proxy-selector'}`);
    } else {
      rules.push(`MATCH,${isDirect ? 'DIRECT' : 'proxy-selector'}`);
    }
  } else {
    rules.push(`MATCH,${isDirect ? 'DIRECT' : 'proxy-selector'}`);
  }

  // rule-sel 组落组（收集完规则后统一定义）
  for (const [groupName, targetName] of ruleSelTargets) {
    groups.push({ name: groupName, type: 'select', proxies: [targetName, 'DIRECT'] });
  }

  // DNS nameserver-policy 引用 rule-set:geosite-cn（+ geolocation-!cn），其 provider 必须在
  // 下方 rule-providers 物化【之前】注册——先物化再注册会导致「not found rule-set: geosite-cn」。
  {
    const dnsRr = mode === 'rule' ? effectiveRegionRouting(config) : null;
    if (dnsRr?.enabled && dnsRr.region === 'cn' && !dnsRr.reverse) {
      registerGeoProvider('geosite', 'geolocation-!cn');
    }
    // 无论分流模式（global/direct/rule 任意分支），policy 恒引用 geosite-cn。
    registerGeoProvider('geosite', 'cn');
  }

  // ---------- rule-providers ----------
  const ruleProviders: Record<string, unknown> = {};
  const runtimeDir = getRuleSetRuntimeDir();
  for (const [name, { category, value }] of usedProviders) {
    // category-ai 在 MetaCubeX 用 category-ai-!cn（与 builtin 模块同源口径）
    const srcName = category === 'geosite' && value === 'category-ai' ? 'category-ai-!cn' : value;
    const localFile = path.join(runtimeDir, `${category}-${srcName}.mrs`);
    const behavior = category === 'geosite' ? 'domain' : 'ipcidr';
    // 本地 .mrs 存在与否运行期才知道；mihomo 的 local provider 缺文件会 FATAL，故恒用 path 仅当文件在，
    // 否则远程。构建期不查 FS（builder 需纯），由 ProxyManager 在写配置前确保本地 .mrs 就绪；
    // 这里两态都生成，选择逻辑沉到 ensureRuleProvidersReady 之后由 deps 注入太绕——直接两态合并：
    // 本地优先用 type:file，远程兜底用 type:http。mihomo 无「本地缺失回退远程」语义，
    // 故采用：构建期查一次 FS（builder 非纯但在主进程内可接受，与 sing-box 版的 isValidSrsFile 前置一致）。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const exists = safeExists(localFile);
    if (exists) {
      ruleProviders[name] = { type: 'file', behavior, format: 'mrs', path: localFile };
    } else {
      ruleProviders[name] = {
        type: 'http',
        behavior,
        format: 'mrs',
        url: `${MRS_REMOTE_BASE}/${category}/${srcName}.mrs`,
        interval: 86400,
      };
    }
  }
  for (const [name, url] of remoteProviders) {
    // 自定义远程规则集：.mrs 按 binary，否则按 classical（yaml/text 列表）
    const isMrs = /\.mrs($|\?)/.test(url);
    ruleProviders[name] = {
      type: 'http',
      behavior: isMrs ? 'domain' : 'classical',
      ...(isMrs ? { format: 'mrs' } : {}),
      url,
      interval: 86400,
    };
  }

  // ---------- DNS ----------
  const dnsCfg = config.dnsConfig;
  const domestic = dnsCfg?.domesticDns || 'https://doh.pub/dns-query';
  const foreign = dnsCfg?.foreignDns || 'https://dns.google/dns-query';
  const enableFakeIp = dnsCfg?.enableFakeIp === true;
  const dns: Record<string, unknown> = {
    enable: true,
    // 对齐 FlClash（0.0.0.0:1053）：TUN dns-hijack 之外的直连 DNS 查询兜底入口。
    listen: '0.0.0.0:1053',
    ipv6: config.enableIPv6 === true,
    'default-nameserver': ['223.5.5.5', '119.29.29.29'],
    'proxy-server-nameserver': [domestic],
    'respect-rules': true,
    nameserver: [foreign],
  };
  // 国内外分流解析：仅 smart 模式且地区分流启用时下发 policy
  const rr = mode === 'rule' ? effectiveRegionRouting(config) : null;
  if (rr?.enabled && rr.region === 'cn' && !rr.reverse) {
    dns['nameserver-policy'] = {
      'rule-set:geosite-geolocation-!cn': [foreign],
      'rule-set:geosite-cn': [domestic],
    };
    // provider 注册已上移至 rule-providers 物化之前（先物化再注册会漏发）。
  } else {
    dns['nameserver-policy'] = { 'rule-set:geosite-cn': [domestic] };
  }
  if (enableFakeIp) {
    dns['enhanced-mode'] = 'fake-ip';
    dns['fake-ip-range'] = '198.18.0.0/15';
    const filter: string[] = ['lan', 'localhost', '*.lan', '*.local', 'time.*.com', 'ntp.*.com'];
    if (config.fakeIpFilter !== false) {
      const userList = config.fakeIpFilterList ?? [...DEFAULT_FAKEIP_FILTER_DOMAINS];
      for (const e of userList) filter.push(fakeIpFilterEntry(e));
    }
    // bypass LAN 域名 + bypassFakeIP 规则域名不进 FakeIP
    if (config.bypassLAN !== false) {
      for (const e of effectiveBypassLan(config)) {
        if (!isIpCidr(e)) filter.push(fakeIpFilterEntry(e));
      }
    }
    for (const rule of config.customRules || []) {
      if (!rule.enabled || !rule.bypassFakeIP) continue;
      if (!['domain', 'domainSuffix', 'domainKeyword'].includes(rule.type)) continue;
      for (const v of rule.values || []) filter.push(fakeIpFilterEntry(v));
    }
    dns['fake-ip-filter'] = [...new Set(filter)];
  }

  // ---------- TUN ----------
  let tun: Record<string, unknown> | undefined;
  if (config.proxyModeType === 'tun') {
    const tc = config.tunConfig;
    const stack = resolveTunStack(tc?.stack, process.platform);
    const mtu = resolveTunMtu(tc?.mtu, process.platform, stack);
    const excludes = new Set<string>();
    if (config.bypassLAN !== false) {
      for (const c of bypassLanCidrs(effectiveBypassLan(config))) excludes.add(c);
    }
    for (const c of tc?.inboundExcludeCidrs || []) excludes.add(c);
    // 绝不可排除 fake-ip 段（198.18.0.0/15）：排除后系统不会把 fake-ip 包路由进 TUN，
    // 应用拿到合成地址却无处可去 → TUN 全局断网（sing-box 语义直接搬过来的遗留错误；FlClash 桌面端不做任何排除）。
    tun = {
      enable: true,
      stack,
      'auto-route': tc?.autoRoute !== false,
      // strict-route 默认关（对齐 FlClash——其 Tun 模型根本没有此字段）：开启会在 Windows 上压制其余网卡
      // 默认路由，多网卡/Hyper-V 桥接环境下极易全断；需要强防泄漏的用户可在设置里显式打开。
      'strict-route': tc?.strictRoute === true,
      'auto-detect-interface': true,
      'dns-hijack': ['any:53'],
      mtu,
      // Windows 必须下发与 ProxyManager 就绪门控同源的固定接口名（缺省 flowz-tun0）：
      // 否则 mihomo 自动命名（Mihomo），门控永远等不到 flowz-tun0 → 误报「TUN 适配器未建立」。
      ...(process.platform === 'win32'
        ? { device: resolveWinTunInterfaceName(config) }
        : tc?.interfaceName
          ? { device: tc.interfaceName }
          : {}),
      ...(tc?.inet4Address ? { 'inet4-address': tc.inet4Address } : {}),
      ...(excludes.size > 0 ? { 'route-exclude-address': [...excludes] } : {}),
    };
  }

  // ---------- 顶层 ----------
  const mihomoConfig: Record<string, unknown> = {
    'mixed-port': localProxyPort(config),
    'allow-lan': config.allowLan === true,
    mode,
    // mihomo 合法级别仅 silent/error/warning/info/debug：FlowZ 的 warn→warning、fatal→error，错值会 FATAL 拒启动。
    'log-level':
      ({ fatal: 'error', warn: 'warning' } as Record<string, string>)[config.logLevel] ||
      config.logLevel ||
      'info',
    'external-controller': `127.0.0.1:${controlApiPort(config)}`,
    ...(config.clashApiSecret ? { secret: config.clashApiSecret } : {}),
    // 与 FlClash 默认一致（其 clash_config 模型 @Default(true)）：URLTest/延迟接口按「去除握手差异」口径计时，
    // 数值更低更贴近体感；false 会把协议握手计入，数值系统性虚高。
    'unified-delay': true,
    ipv6: config.enableIPv6 === true,
    dns,
    ...(tun ? { tun } : {}),
    ...(listeners.length > 0 ? { listeners } : {}),
    proxies,
    'proxy-groups': groups,
    ...(Object.keys(ruleProviders).length > 0 ? { 'rule-providers': ruleProviders } : {}),
    rules,
  };

  return { config: mihomoConfig, idToTagMap, ruleSelectors, warnings };
}

/** 构建期 FS 存在性检查（本地 .mrs 优先策略）；失败按不存在处理（回退远程 provider）。 */
function safeExists(p: string): boolean {
  try {
    // 延迟 require，避免 builder 在纯函数单测环境里硬依赖 fs 行为
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}
