/**
 * auto-mode.ts — 「自动选优」与「节点故障自动切换」的互斥开关（单一真值）。
 *
 * 为什么单独一处：两个开关在两处 UI 出现（首页出口行的图标按钮、设置 → 网络），
 * 且主进程也依赖「不会同时为 true」这个前提（见 index.ts / config-change-handler.ts 里
 * `autoSwitchNode && !autoSelectFastest` 的启停判断）。逻辑散在两处迟早漂移成
 * 「首页互斥、设置页不互斥」，然后两套逻辑又开始抢同一个 proxy-selector。
 *
 * 语义：**开启任一个 → 强制关掉另一个**；关闭任一个 → 只关自身，不擅自替用户打开另一个。
 * （否则「关掉自动选优」会意外启动心跳换节点，是用户没要求的行为变化。）
 */
import type { UserConfig } from './types';

export type AutoMode = 'autoSelectFastest' | 'autoSwitchNode';

/** 返回一份新的配置对象；绝不原地修改入参（React store 依赖引用变化）。 */
export function withAutoMode(config: UserConfig, mode: AutoMode, enabled: boolean): UserConfig {
  const other: AutoMode = mode === 'autoSelectFastest' ? 'autoSwitchNode' : 'autoSelectFastest';
  return {
    ...config,
    [mode]: enabled,
    ...(enabled ? { [other]: false } : {}),
  };
}
