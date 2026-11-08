/**
 * latency-filter.ts — 「隐藏超时节点」的判定与过滤（单一真值）。
 *
 * 为什么单独一处：超时节点会同时出现在两个界面（节点页列表、首页出口下拉），口径漂移就会出现
 * 「列表里隐藏了、下拉里还看得到」。这里只认 latencyMap 里的数值，不碰 React / store / i18n。
 *
 * 数值约定（与 server-card / node-picker-logic / use-kernel-latency-sync 一致）：
 *   · -1 = 测速超时 / 失败；0 = 内核 delay 接口的失败值（同步 hook 会转成 -1，这里仍兜住）；
 *   · undefined = **从未测过** —— 绝不能当成超时隐藏，否则装好还没点测速时列表会整个空掉。
 */
export function isTimeoutLatency(latency: number | undefined): boolean {
  return typeof latency === 'number' && latency <= 0;
}

/**
 * 过滤超时节点。
 * @param keepIds 永不隐藏的 id（首页下拉里的「直连」哨兵、当前选中出口）——
 *                否则用户正在用的节点会因为一次测速失败从下拉里凭空消失。
 */
export function filterTimeoutNodes<T extends { id: string }>(
  nodes: readonly T[],
  latencyMap: Record<string, number>,
  hide: boolean,
  keepIds: ReadonlySet<string> = new Set<string>()
): T[] {
  if (!hide) return [...nodes];
  return nodes.filter((n) => keepIds.has(n.id) || !isTimeoutLatency(latencyMap[n.id]));
}

/** 被隐藏的数量（工具栏徽标用；keepIds 里的不算隐藏）。 */
export function countHiddenTimeoutNodes<T extends { id: string }>(
  nodes: readonly T[],
  latencyMap: Record<string, number>,
  hide: boolean,
  keepIds: ReadonlySet<string> = new Set<string>()
): number {
  if (!hide) return 0;
  return nodes.filter((n) => !keepIds.has(n.id) && isTimeoutLatency(latencyMap[n.id])).length;
}
