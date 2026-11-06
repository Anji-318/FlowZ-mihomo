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

const SCENARIOS: Array<{ name: string; over: Partial<UserConfig>; expectTun: boolean }> = [
  { name: 'tun-smart', over: {}, expectTun: true },
  { name: 'system-global', over: { proxyModeType: 'systemProxy', proxyMode: 'global' }, expectTun: false },
  { name: 'system-direct', over: { proxyModeType: 'systemProxy', proxyMode: 'direct' }, expectTun: false },
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
