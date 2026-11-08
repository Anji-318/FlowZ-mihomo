import { withAutoMode } from '../auto-mode';
import type { UserConfig } from '../types';

const base = (over: Partial<UserConfig> = {}) => ({ ...over }) as UserConfig;

describe('withAutoMode — 自动选优 / 故障转移双向互斥', () => {
  it('开启自动选优 → 强制关闭故障转移', () => {
    const out = withAutoMode(base({ autoSwitchNode: true }), 'autoSelectFastest', true);
    expect(out.autoSelectFastest).toBe(true);
    expect(out.autoSwitchNode).toBe(false);
  });

  it('开启故障转移 → 强制关闭自动选优', () => {
    const out = withAutoMode(base({ autoSelectFastest: true }), 'autoSwitchNode', true);
    expect(out.autoSwitchNode).toBe(true);
    expect(out.autoSelectFastest).toBe(false);
  });

  it('关闭自动选优 → 只关自身，不擅自打开故障转移', () => {
    const out = withAutoMode(
      base({ autoSelectFastest: true, autoSwitchNode: false }),
      'autoSelectFastest',
      false
    );
    expect(out.autoSelectFastest).toBe(false);
    expect(out.autoSwitchNode).toBe(false);
  });

  it('关闭故障转移 → 只关自身，不擅自打开自动选优', () => {
    const out = withAutoMode(
      base({ autoSelectFastest: false, autoSwitchNode: true }),
      'autoSwitchNode',
      false
    );
    expect(out.autoSwitchNode).toBe(false);
    expect(out.autoSelectFastest).toBe(false);
  });

  it('结果永不出现两个同时为 true（含脏历史配置）', () => {
    const dirty = base({ autoSelectFastest: true, autoSwitchNode: true });
    for (const mode of ['autoSelectFastest', 'autoSwitchNode'] as const) {
      const out = withAutoMode(dirty, mode, true);
      expect(out.autoSelectFastest === true && out.autoSwitchNode === true).toBe(false);
    }
  });

  it('不修改入参；其余字段原样保留', () => {
    const input = base({
      autoSwitchNode: true,
      selectedServerId: 'node-42',
      proxyMode: 'global',
    } as UserConfig);
    const out = withAutoMode(input, 'autoSelectFastest', true);
    expect(input.autoSelectFastest).toBeUndefined();
    expect(input.autoSwitchNode).toBe(true);
    expect(out.selectedServerId).toBe('node-42');
    expect(out.proxyMode).toBe('global');
    expect(out).not.toBe(input);
  });
});
