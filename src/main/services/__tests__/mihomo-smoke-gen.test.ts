/**
 * 冒烟：用真实 builder 生成 mihomo 配置并落盘，供外部 `mihomo -t` 校验。
 * 不断言内部结构，只保证 builder 能跑通并产出 YAML。
 */
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir() + '/flowz-mihomo-smoke-workdir' },
}));

import { buildMihomoConfig } from '../mihomo/mihomo-config-builder';
import type { UserConfig } from '../../../shared/types';

const mk = (over: Partial<UserConfig>): UserConfig => over as unknown as UserConfig;

test('generate mihomo config yaml for smoke test', () => {
  const config = mk({
    mixedPort: 7890,
    controlPort: 9090,
    proxyModeType: 'tun',
    allowLan: true,
    enableIPv6: false,
    logLevel: 'info',
    selectedServerId: 's1',
    servers: [
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
        xhttpSettings: {
          path: 'speed=1.2.3.4', host: 'cdn.example.com', mode: 'stream-one',
          extra: {
            'x-padding-header': 'X-Request-Signature', 'x-padding-key': '_tk',
            'x-padding-method': 'tokenish', 'x-padding-obfs-mode': true,
            'x-padding-placement': 'queryInHeader',
          },
        },
      },
    ],
    customRules: [
      { id: 'r1', type: 'geosite', values: ['google'], enabled: true, action: 'proxy', targetServerId: 's2' },
      { id: 'r2', type: 'domainSuffix', values: ['example.com'], enabled: true, action: 'direct' },
      { id: 'r3', type: 'geosite', values: ['category-ads-all'], enabled: true, action: 'block' },
    ],
    dnsConfig: { domesticDns: 'https://doh.pub/dns-query', foreignDns: 'https://dns.google/dns-query', enableFakeIp: true },
    tunConfig: { mtu: 1500, stack: 'mixed', autoRoute: true, strictRoute: true },
    regionRouting: { enabled: true, region: 'cn', reverse: false },
  });

  const result = buildMihomoConfig(config, {
    gateInvalidNodes: new Set(),
    probeDirectPort: 0,
    probeProxyPort: 0,
    updateInPort: 0,
    probePoolPorts: [],
    log: () => {},
  });

  const out = require('os').tmpdir() + '/flowz-mihomo-smoke-config.yaml';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, yaml.dump(result.config, { noRefs: true, lineWidth: -1 }));
  expect(fs.existsSync(out)).toBe(true);
  console.log('WARNINGS:', JSON.stringify(result.warnings));
});
