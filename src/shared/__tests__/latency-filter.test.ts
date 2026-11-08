import {
  isTimeoutLatency,
  filterTimeoutNodes,
  countHiddenTimeoutNodes,
} from '../latency-filter';

type Node = { id: string; name: string };
const nodes: Node[] = [
  { id: 'fast', name: 'fast' },
  { id: 'slow', name: 'slow' },
  { id: 'dead', name: 'dead' },
  { id: 'zero', name: 'zero' },
  { id: 'untested', name: 'untested' },
];
const lat = { fast: 46, slow: 320, dead: -1, zero: 0 };

describe('isTimeoutLatency', () => {
  it('-1 与 0 视为超时/失败', () => {
    expect(isTimeoutLatency(-1)).toBe(true);
    expect(isTimeoutLatency(0)).toBe(true);
  });
  it('正数与「未测过」不视为超时', () => {
    expect(isTimeoutLatency(46)).toBe(false);
    expect(isTimeoutLatency(1000)).toBe(false);
    expect(isTimeoutLatency(undefined)).toBe(false);
  });
});

describe('filterTimeoutNodes', () => {
  it('关闭开关 → 原样返回（且返回新数组，不改入参）', () => {
    const out = filterTimeoutNodes(nodes, lat, false);
    expect(out).toEqual(nodes);
    expect(out).not.toBe(nodes);
  });

  it('开启开关 → 只隐藏 -1 / 0，未测速节点保留', () => {
    expect(filterTimeoutNodes(nodes, lat, true).map((n) => n.id)).toEqual([
      'fast',
      'slow',
      'untested',
    ]);
  });

  it('keepIds 里的节点永不隐藏（当前出口 / 直连哨兵）', () => {
    const out = filterTimeoutNodes(nodes, lat, true, new Set(['dead', 'zero']));
    expect(out.map((n) => n.id)).toEqual(['fast', 'slow', 'dead', 'zero', 'untested']);
  });

  it('全部超时且开关开启 → 空列表（由调用方给空态提示）', () => {
    const allDead = [{ id: 'a' }, { id: 'b' }];
    expect(filterTimeoutNodes(allDead, { a: -1, b: -1 }, true)).toEqual([]);
  });
});

describe('countHiddenTimeoutNodes', () => {
  it('关闭时为 0', () => {
    expect(countHiddenTimeoutNodes(nodes, lat, false)).toBe(0);
  });
  it('开启时统计被隐藏数，keepIds 不计入', () => {
    expect(countHiddenTimeoutNodes(nodes, lat, true)).toBe(2);
    expect(countHiddenTimeoutNodes(nodes, lat, true, new Set(['dead']))).toBe(1);
  });
});
