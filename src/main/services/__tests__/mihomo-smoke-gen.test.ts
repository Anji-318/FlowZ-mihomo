/**
 * mihomo 配置生成回归测试（冒烟 + 结构断言 + 真实内核校验）。
 *
 * 背景（这次审计发现的空缺）：内核从 sing-box 换成 mihomo 后，559 行的 mihomo-config-builder
 * 只有 87 行「生成个 YAML 就算过」的冒烟测试，`mihomo -t` 从未进入 CI/发布链路 —— 改错一条规则映射，
 * 只有真机起核才会炸。本文件补三件事：
 *   1. 结构断言：组顺序、选中节点置顶、规则非空、TUN 开关、management API 绑定与 secret。
 *   2. 多场景：TUN+智能 / 系统代理+全局 / 系统代理+直连（三条代码分支都被覆盖）。
 *   3. 真内核校验：设 MIHOMO_VERIFY=1（`npm run verify:config` 与 package:* 链路）时调
 *      `mihomo -t -f <yaml>`，非零退出即失败；未设则跳过（`npm test` 不强制要求仓库里有核）。
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';

jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir() + '/flowz-mihomo-smoke-workdir' },
}));

import { buildMihomoConfig } from '../mihomo/mihomo-config-builder';
import type { UserConfig } from '../../../shared/types';

/** 真实 builder 需要的最小节点集：覆盖 vless/reality + ws、trojan、hysteria2、shadowsocks、vless+xhttp。 */
const SERVERS: any[] = [
  {
    id: 's1', name: 'HK VLESS', protocol: 'vless', address: '1.2.3.4', port: 443,
    uuid: '11111111-2222-3333-4444-555555555555', flow: 'xtls-rprx-vision',
    tlsSettings: { serverName: 'www.microsoft.com', fingerprint: 'chrome' },
    realitySettings: { publicKey: 'jnxHtSFQOKFnHLfVKMqP_HnhOpjQi9eP1KDFJ8LIgV8', shortId: '01' },
    wsSettings: { path: '/ws', headers: { Host: 'cdn.example.com' } },
    network: 'ws', security: 'reality',
  },
  {
    id: 's2', name: 'JP Trojan', protocol: 'trojan', address: '5.6.7.8', port: 443,
    password: 'pass', tlsSettings: { serverName: 'jp.example.com' }, security: 'tls',
  },
  {
    id: 's3', name: 'SG Hy2', protocol: 'hysteria2', address: '9.10.11.12', port: 443,
    password: 'hy2pass', tlsSettings: { serverName: 'sg.example.com', allowInsecure: true },
  },
  {
    id: 's4', name: 'US SS', protocol: 'shadowsocks', address: '13.14.15.16', port: 8388,
    shadowsocksSettings: { method: 'aes-128-gcm', password: 'sspass' },
  },
  {
    id: 's5', name: 'CDN XHTTP', protocol: 'vless', address: '104.17.51.141', port: 443,
    uuid: '11111111-2222-3333-4444-555555555555',
    tlsSettings: { serverName: 'cdn.example.com', alpn: ['h2', 'http/1.1'], fingerprint: 'chrome' },
    network: 'xhttp', security: 'tls',
    xhttpSettings: { path: 'speed=1.2.3.4', host: 'cdn.example.com', mode: 'stream-one' },
  },
];

const BASE: Partial<UserConfig> = {
  mixedPort: 7890,
  controlPort: 9090,
  clashApiSecret: 'smoke-secret',
  proxyMode: 'smart',
  proxyModeType: 'tun',
  allowLan: false,
  enableIPv6: false,
  logLevel: 'info',
  selectedServerId: 's1',
  servers: SERVERS as any,
  customRules: [
    { id: 'r1', type: 'geosite', values: ['google'], enabled: true, action: 'proxy', targetServerId: 's2' },
    { id: 'r2', type: 'domainSuffix', values: ['example.com'], enabled: true, action: 'direct' },
    { id: 'r3', type: 'geosite', values: ['category-ads-all'], enabled: true, action: 'block' },
  ] as any,
  dnsConfig: { domesticDns: 'https://doh.pub/dns-query', foreignDns: 'https://dns.google/dns-query', enableFakeIp: true } as any,
  tunConfig: { mtu: 1500, stack: 'mixed', autoRoute: true, strictRoute: true } as any,
  regionRouting: { enabled: true, region: 'cn', reverse: false } as any,
};

const DEPS = {
  gateInvalidNodes: new Set<string>(),
  probeDirectPort: 0,
  probeProxyPort: 0,
  updateInPort: 0,
  probePoolPorts: [] as number[],
  log: () => {},
};

/**
 * 全矩阵：3 种接管方式 × 3 种路由模式，外加「自动选优」专项。
 * 之前只覆盖了 tun+smart / system+global / system+direct，manual（仅本地）与 tun+global/direct 从未被校验过 ——
 * 而这几条正是「换了内核后最容易悄悄坏掉」的分支（TUN 段是否存在、mode 映射、mixed-port 是否还在绑）。
 */
const MODE_TYPES = [
  { type: 'tun' as const, expectTun: true },
  { type: 'systemProxy' as const, expectTun: false },
  { type: 'manual' as const, expectTun: false }, // 仅本地：不接管系统，只开 mixed 端口
];
const ROUTE_MODES = [
  { mode: 'smart' as const, expectMihomoMode: 'rule' },
  { mode: 'global' as const, expectMihomoMode: 'global' },
  { mode: 'direct' as const, expectMihomoMode: 'direct' },
];

const SCENARIOS = [
  ...MODE_TYPES.flatMap((t) =>
    ROUTE_MODES.map((r) => ({
      name: `${t.type}-${r.mode}`,
      over: { proxyModeType: t.type, proxyMode: r.mode } as Partial<UserConfig>,
      expectTun: t.expectTun,
      expectMihomoMode: r.expectMihomoMode as string,
    }))
  ),
  {
    name: 'tun-smart-urltest',
    over: {
      autoSelectFastest: true,
      urltestIntervalSec: 30,
      urltestToleranceMs: 50,
    } as Partial<UserConfig>,
    expectTun: true,
    expectMihomoMode: 'rule',
  },
];

/** 按平台定位仓库内的随包内核（未 fetch 时可能不存在）。 */
function findCoreBinary(): string | null {
  const root = path.resolve(__dirname, '../../../..');
  const rel =
    process.platform === 'win32'
      ? 'resources/win/mihomo.exe'
      : process.platform === 'darwin'
        ? `resources/mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}/mihomo`
        : 'resources/linux/mihomo';
  const p = path.join(root, rel);
  return fs.existsSync(p) ? p : null;
}

describe('mihomo 配置生成（结构回归）', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: 产出可被内核接受的骨架`, () => {
      const config = { ...BASE, ...sc.over } as UserConfig;
      const result = buildMihomoConfig(config, DEPS);
      const cfg = result.config as any;

      // 节点：5 个全部落地（mihomo 侧不支持 naive/ssh/tailscale/custom，本用例不含）
      expect(Array.isArray(cfg.proxies)).toBe(true);
      expect(cfg.proxies).toHaveLength(5);
      expect(cfg.proxies.map((p: any) => p.type)).toEqual(
        expect.arrayContaining(['vless', 'trojan', 'hysteria2', 'ss'])
      );

      // 组：主选择器必须存在，且「选中节点置顶」（mihomo select 组默认选第一个，热切换前提）
      const selector = (cfg['proxy-groups'] as any[]).find((g) => g.name === 'proxy-selector');
      expect(selector).toBeTruthy();
      expect(selector.proxies[0]).toBe('HK VLESS');

      // 管理面：只绑 127.0.0.1 且带 secret（本地恶意进程也不能裸调 API）
      expect(cfg['external-controller']).toBe('127.0.0.1:9090');
      expect(cfg.secret).toBe('smoke-secret');
      // 三种接管方式都必须绑本地 mixed 端口：manual（仅本地）全靠它，TUN/系统代理也用它做探针与更新借道
      expect(cfg['mixed-port']).toBe(7890);
      // 路由模式映射：smart→rule / global→global / direct→direct（mihomo 认的是 mode 字段）
      expect(cfg.mode).toBe(sc.expectMihomoMode);

      // 模式映射：smart→rule 必须产出规则；global/direct 不应误留 rule 规则
      if (cfg.mode === 'rule') {
        expect(Array.isArray(cfg.rules)).toBe(true);
        expect(cfg.rules.length).toBeGreaterThan(0);
      }

      // TUN 只在该模式下出现，且 dns-hijack 必须存在（否则 DNS 泄漏）
      if (sc.expectTun) {
        expect(cfg.tun).toBeTruthy();
        expect(cfg.tun['dns-hijack']).toContain('any:53');
        expect(cfg.tun['auto-route']).toBe(true);
      } else {
        expect(cfg.tun).toBeUndefined();
      }

      // 不支持的协议不该被静默塞进配置
      expect(result.warnings.join(' ')).not.toContain('ERROR');
    });
  }
});

describe('自动选优（url-test）组生成', () => {
  it('开启后 proxy-selector 变成 url-test，参数来自客户端设置', () => {
    const config = {
      ...BASE,
      autoSelectFastest: true,
      urltestIntervalSec: 30,
      urltestToleranceMs: 80,
    } as UserConfig;
    const cfg = buildMihomoConfig(config, DEPS).config as any;
    const selector = (cfg['proxy-groups'] as any[]).find((g) => g.name === 'proxy-selector');

    expect(selector.type).toBe('url-test');
    expect(selector.url).toBe('https://www.gstatic.com/generate_204');
    expect(selector.interval).toBe(30);
    expect(selector.tolerance).toBe(80);
    // lazy=false：不依赖「组被命中」才测速，起核初期就有延迟数据
    expect(selector.lazy).toBe(false);
    // 只有主选择器走 url-test；规则目标组仍是 select（各自钉死目标，不能自动漂移）
    expect((cfg['proxy-groups'] as any[]).filter((g) => g.type === 'url-test')).toHaveLength(1);
  });

  it('非法/越界参数被夹取，不会把 NaN 写进内核配置', () => {
    const cfg = buildMihomoConfig(
      { ...BASE, autoSelectFastest: true, urltestIntervalSec: NaN, urltestToleranceMs: 999999 } as UserConfig,
      DEPS
    ).config as any;
    const selector = (cfg['proxy-groups'] as any[]).find((g) => g.name === 'proxy-selector');
    expect(selector.interval).toBe(60); // 默认
    expect(selector.tolerance).toBe(2000); // 上限
  });

  it('未开启时保持 select（零行为变化）', () => {
    const cfg = buildMihomoConfig({ ...BASE } as UserConfig, DEPS).config as any;
    const selector = (cfg['proxy-groups'] as any[]).find((g) => g.name === 'proxy-selector');
    expect(selector.type).toBe('select');
    expect(selector.interval).toBeUndefined();
  });
});

describe('mihomo 配置生成（真实内核校验）', () => {
  const verify = process.env.MIHOMO_VERIFY === '1';
  const bin = findCoreBinary();

  it('mihomo -t 能接受生成的配置', () => {
    if (!verify) {
      console.log('[skip] 未设 MIHOMO_VERIFY=1 → 跳过真内核校验（npm test 不强制要求仓库内有核）');
      return;
    }
    // verify 模式是发布门禁：核缺失必须硬失败，不能静默跳过（否则门形同虚设）。
    expect(bin).toBeTruthy();

    for (const sc of SCENARIOS) {
      const config = { ...BASE, ...sc.over } as UserConfig;
      const result = buildMihomoConfig(config, DEPS);
      const dir = path.join(os.tmpdir(), 'flowz-mihomo-verify');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sc.name}.yaml`);
      fs.writeFileSync(file, yaml.dump(result.config, { noRefs: true, lineWidth: -1 }), 'utf-8');

      let stderr = '';
      try {
        execFileSync(bin as string, ['-t', '-f', file], { timeout: 30_000, stdio: 'pipe' });
      } catch (e: any) {
        stderr = `${e?.stdout ?? ''}${e?.stderr ?? ''}`;
        throw new Error(`mihomo -t 拒绝配置 ${sc.name}: ${stderr || e?.message}`);
      }
    }
  });
});
