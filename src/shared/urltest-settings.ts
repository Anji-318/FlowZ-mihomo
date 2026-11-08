/**
 * urltest-settings.ts — 内核 url-test 组的参数解析（单一真值）。
 *
 * 为什么单独一处：url-test 的 interval/tolerance 既影响配置生成（mihomo YAML），也影响设置页回显、
 * 诊断报告与单测。散落各处迟早漂移（比如 UI 显示 60s、实际生成 300s），故收口到本文件的 clamp。
 *
 * 取值依据：
 *   · interval 下限 10s —— 再短探测流量与节点压力都不划算；上限 1h —— 再长等于没有自动切换。
 *   · 默认 60s：比 mihomo 生态默认（300s）激进，因为本项目的卖点之一是「坏节点尽快切走」；
 *     60s × 20 节点 ≈ 2.9 万次/天，仍在可接受范围（每次请求仅几百字节）。
 *   · tolerance 默认 20ms：50ms 会让「65ms vs 112ms」这种 47ms 的明显差距不触发切换（实测被用户当成失效），
 *     20ms 只挡掉 87↔90 这种正常抖动。
 */
import { DEFAULT_SPEED_TEST_URL } from './speed-test';

export const DEFAULT_URLTEST_INTERVAL_SEC = 60;
export const MIN_URLTEST_INTERVAL_SEC = 10;
export const MAX_URLTEST_INTERVAL_SEC = 3600;
export const DEFAULT_URLTEST_TOLERANCE_MS = 20;
export const MAX_URLTEST_TOLERANCE_MS = 2000;

/** 设置页给出的预设（秒）。自由输入也会被 clamp 到 [MIN, MAX]。 */
export const URLTEST_INTERVAL_PRESETS = [30, 60, 120, 300] as const;

/**
 * 设置页给出的容差预设（毫秒）。0 = 不设容差，严格选最低延迟 —— 对「纯粹要最快」的用户，
 * 代价是两个相差几 ms 的节点会随测速噪声来回切；50/100 留给「长连接稳定优先」的用户。
 */
export const URLTEST_TOLERANCE_PRESETS = [0, 20, 50, 100] as const;

export interface ResolvedUrltest {
  /** 秒，已取整并 clamp。 */
  interval: number;
  /** 毫秒，已取整并 clamp。 */
  tolerance: number;
  /** 测速端点（与主核测速/FlClash 同口径）。 */
  url: string;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 解析用户配置里的 url-test 参数；缺失/非法一律回落默认（绝不把 NaN 写进内核配置）。 */
export function resolveUrltestSettings(config: {
  urltestIntervalSec?: number;
  urltestToleranceMs?: number;
}): ResolvedUrltest {
  return {
    interval: clampInt(
      config.urltestIntervalSec,
      MIN_URLTEST_INTERVAL_SEC,
      MAX_URLTEST_INTERVAL_SEC,
      DEFAULT_URLTEST_INTERVAL_SEC
    ),
    tolerance: clampInt(
      config.urltestToleranceMs,
      0,
      MAX_URLTEST_TOLERANCE_MS,
      DEFAULT_URLTEST_TOLERANCE_MS
    ),
    url: DEFAULT_SPEED_TEST_URL,
  };
}
