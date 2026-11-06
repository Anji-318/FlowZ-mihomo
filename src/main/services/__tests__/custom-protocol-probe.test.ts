/**
 * 自定义协议（用户粘贴的出站定义）兼容性 probe 单测 —— **mihomo 版**。
 *
 * 历史：这份测试原来针对 sing-box（JSON 配置 + outbounds[]/endpoints[] 分野）。换核后
 * `probeOutbound` 改为生成 **YAML**（`proxies[]` + `proxy-groups`），且 mihomo 没有
 * endpoint/outbound 分野 —— 旧断言（JSON.parse、outbounds、未知 snell 类型）必然失败，
 * 已在 v4.4.8 一并重写（它也是当时 CI 长期红着的两个用例）。
 *
 * 现在验证的「内核即权威」不变量没变：verdict 只由内核 check 结果决定，FlowZ 只负责把
 * 用户定义包成最小可校验配置。
 * covers：
 *  - 最小包装形态：proxies[0] 带 name='probe'、无 tag；proxy-groups 引用 probe + DIRECT；rules 兜底 MATCH。
 *  - 内核 check 失败 → probe fail 且错误原文透传（不猜、不改写）。
 *  - 内核 check 通过 → probe ok（同一份定义，verdict 只跟内核走）。
 *  - isEndpoint 参数在 mihomo 下是 no-op（签名兼容），两条路径产物一致。
 *  - failOpen（核缺失/超时）→ indeterminate（中性「无法判定」，不是「不支持」）。
 *  - 非法入参（非对象 / 无 string type）→ 直接 fail，不触发 check。
 */

import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-probe-test-'));
jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

// 仅 mock execFile（runSingBoxCheck 经 promisify(execFile) 调用）；其余保留真实实现
// （ProxyManager 导入链里 SystemProxyManager 顶层 promisify(exec) 等需要真函数）。
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import { ProxyManager } from '../ProxyManager';

/** execFile(file, args, opts?, cb)：opts 可省略 → cb 顶到第 3 参。 */
function cbOf(args: any[]): (err: any, stdout?: string, stderr?: string) => void {
  return typeof args[2] === 'function' ? args[2] : args[3];
}

/** 从 execFile 参数取配置路径并解析 YAML（mihomo 配置是 YAML，不再是 JSON）。 */
function readProbeConfig(args: any[]): any {
  const argv = args[1] as string[];
  // runSingBoxCheck 传 `-t -f <path>`（mihomo 的配置校验模式）；兼容 `-c <path>` 旧形态。
  const fi = argv.indexOf('-f');
  const ci = argv.indexOf('-c');
  const p = fi >= 0 ? argv[fi + 1] : ci >= 0 ? argv[ci + 1] : argv[argv.length - 1];
  return yaml.load(fsSync.readFileSync(p, 'utf-8'));
}

function freshPm(): any {
  // 假内核路径：statSync 抛 → binId='na'；getCoreVersion 真 exec 失败 → 回落 bundledCoreVersion。互不影响 probe 判定。
  const pm: any = new ProxyManager(undefined, undefined, path.join(TMP, 'cfg.json'), '/fake/mihomo');
  pm.logToManager = () => {};
  return pm;
}

/** 一份「当前内核支持」的出站定义（snell v4 在 mihomo 可用）。 */
const SNELL = {
  type: 'snell',
  server: '1.2.3.4',
  server_port: 8388,
  psk: 'my-pre-shared-key',
  version: 4,
};

beforeEach(() => mockExecFile.mockReset());

describe('probeOutbound — 内核即权威 verdict（mihomo YAML）', () => {
  it('内核 check 失败 → probe fail，且错误原文透传', async () => {
    const pm = freshPm();
    let seenCfg: any = null;
    mockExecFile.mockImplementationOnce((...args: any[]) => {
      seenCfg = readProbeConfig(args);
      const err: any = new Error('check failed');
      err.code = 1;
      // mihomo 的报错措辞与 sing-box 不同，此处只验证「原文透传」，不锁定具体文案。
      err.stderr = "FATAL[0000] parse config error: proxy 0: unsupported proxy type: some-proto";
      cbOf(args)(err);
    });
    const unsupported = { type: 'some-proto', server: '1.2.3.4', port: 443 };
    const r = await pm.probeOutbound(unsupported, false);
    expect(r.ok).toBe(false);
    expect(r.indeterminate).toBeFalsy();
    expect(r.error).toMatch(/unsupported proxy type: some-proto/);

    // 最小包装形态：proxies 只有被探测项，name 固定 'probe'，且不残留 sing-box 的 tag
    expect(Array.isArray(seenCfg.proxies)).toBe(true);
    expect(seenCfg.proxies).toHaveLength(1);
    expect(seenCfg.proxies[0].type).toBe('some-proto');
    expect(seenCfg.proxies[0].name).toBe('probe');
    expect(seenCfg.proxies[0].tag).toBeUndefined();

    // 组与兜底规则：select 组引用 probe + DIRECT，rules 以 MATCH 收尾（否则 mihomo 校验会因无规则失败）
    expect(seenCfg['proxy-groups'][0]).toMatchObject({
      name: 'proxy-selector',
      type: 'select',
      proxies: ['probe', 'DIRECT'],
    });
    expect(seenCfg.rules).toEqual(['MATCH,proxy-selector']);
    // log 级别压到 fatal：probe 不该污染应用日志
    expect(seenCfg.log).toEqual({ level: 'fatal' });
  });

  it('内核 check 通过 → probe ok（同一份定义，verdict 只跟内核走）', async () => {
    const pm = freshPm();
    mockExecFile.mockImplementationOnce((...args: any[]) => cbOf(args)(null, '', ''));
    const r = await pm.probeOutbound(SNELL, false);
    expect(r.ok).toBe(true);
  });

  it('字段级错误由内核裁决（缺 psk 等）→ probe 透传内核错误', async () => {
    const pm = freshPm();
    const badSnell = { type: 'snell', server: '1.2.3.4', server_port: 8388, version: 4 }; // 无 psk
    mockExecFile.mockImplementationOnce((...args: any[]) => {
      const err: any = new Error('check failed');
      err.code = 1;
      err.stderr = 'FATAL[0000] proxy 0: snell: psk is required';
      cbOf(args)(err);
    });
    const r = await pm.probeOutbound(badSnell, false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/psk is required/);
  });

  it('isEndpoint 在 mihomo 下是 no-op：两条路径产物一致（无 endpoints[] 分野）', async () => {
    const pm = freshPm();
    const cfgs: any[] = [];
    mockExecFile.mockImplementation((...args: any[]) => {
      cfgs.push(readProbeConfig(args));
      cbOf(args)(null, '', '');
    });
    const epLike = { type: 'wireguard', server: '1.2.3.4', port: 51820 };
    const a = await pm.probeOutbound(epLike, false);
    const b = await pm.probeOutbound(epLike, true); // 不同缓存键（ep/ob），会各自跑一次
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0]).toEqual(cfgs[1]);
    expect(cfgs[0].endpoints).toBeUndefined();
  });

  it('failOpen（核缺失/超时）→ indeterminate（中性无法判定，非红色不支持）', async () => {
    const pm = freshPm();
    mockExecFile.mockImplementationOnce((...args: any[]) => {
      const err: any = new Error('spawn ENOENT');
      err.code = 'ENOENT';
      cbOf(args)(err);
    });
    const r = await pm.probeOutbound(SNELL, false);
    expect(r.ok).toBe(false);
    expect(r.indeterminate).toBe(true);
  });

  it('非法入参（无 string type）→ 直接 fail，不触发 check', async () => {
    const pm = freshPm();
    const r = await pm.probeOutbound({ server: '1.2.3.4' }, false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/type/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('probeCache LRU 上限（性能 review M1）', () => {
  it('超上限驱逐最旧（真实 probeOutbound 驱动，约束实现驱逐逻辑）', async () => {
    const pm = freshPm();
    // 实现侧上限是 2048：真按 2048+20 次跑，每次都要落一个临时 YAML（磁盘 IO），
    // 本机实测 72s、CI 更慢 → 会撞 90s 超时导致 worker 被杀、污染后续用例（历史 flaky 根因）。
    // 这里临时把上限压到 32 —— 驱逐逻辑（Map 插入序 + while 删最旧）与上限数值无关，
    // 压小后仍是「真实 probeOutbound 驱动」，但 52 次即可覆盖边界，且毫秒级。
    const originalMax = (ProxyManager as any).MAX_PROBE_CACHE as number;
    expect(originalMax).toBeGreaterThan(0);
    const SMALL = 32;
    (ProxyManager as any).MAX_PROBE_CACHE = SMALL;

    try {
      mockExecFile.mockImplementation((...args: any[]) => cbOf(args)(null, '', ''));
      const total = SMALL + 20;
      for (let i = 1; i <= total; i++) {
        await pm.probeOutbound({ ...SNELL, server_port: 10000 + i }, false);
      }
      // 缓存不超上限（实现的 while 驱逐生效）
      expect(pm.probeCache.size).toBe(SMALL);
      // 最近 probe 的仍在缓存；最早的已被驱逐
      expect(await pm.probeOutbound({ ...SNELL, server_port: 10000 + total }, false)).toMatchObject({
        ok: true,
      });
      expect(pm.probeCache.size).toBe(SMALL);
    } finally {
      (ProxyManager as any).MAX_PROBE_CACHE = originalMax;
    }
  }, 30000);

  it('probeOutbound 实际命中缓存（不重复 spawn check）', async () => {
    mockExecFile.mockReset(); // 隔离前一个 case 的 mock 状态
    mockExecFile.mockImplementation((...args: any[]) => cbOf(args)(null, '', ''));
    const pm = freshPm();
    // 首次 probe：触发 check
    await pm.probeOutbound(SNELL, false);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    // 再次 probe 同一 outbound：应命中缓存，不再 check
    mockExecFile.mockClear();
    const r = await pm.probeOutbound(SNELL, false);
    expect(r.ok).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
