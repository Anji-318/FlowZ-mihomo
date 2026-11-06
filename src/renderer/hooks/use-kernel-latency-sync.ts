/**
 * 自动选优（url-test）下的延迟回灌。
 *
 * 为什么需要：节点列表里的延迟**只有用户手动点「测速」才会更新**（`latencyMap` 是会话内存态）。
 * 而自动选优一开，内核每 `interval` 秒都会自己测一轮并据此切换出口 —— 两边数据源不同步，
 * 就会出现「界面显示某节点 65ms，内核其实已经 503 超时，于是切到了另一个 63ms 的节点」这种
 * 看起来「自动选优失效」的错觉（实测踩过，用户据此判定功能没生效）。
 *
 * 做法：自动选优开启且内核在跑时，每 30s 拉一次 `GET /proxies` 的 `history` 末项（内核视角的真值），
 * 按节点名映射回 serverId 后并入同一个 `latencyMap`。这样：
 *   · 列表数字 = 内核数字，用户看到的「最低延迟」与内核选中的一致；
 *   · 已失效节点会显示「超时」而不是挂着过期的 65ms。
 *
 * 注意：只读，不触发新测速（避免与内核自己的 interval 重复加压）；手动测速仍可覆盖（同一写入路径）。
 */
import { useEffect } from 'react';
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';

/** 与内核默认 url-test interval（60s）错开一半，保证列表最多滞后约 30s。 */
const SYNC_INTERVAL_MS = 30_000;

export function useKernelLatencySync(): void {
  const auto = useAppStore((s) => s.config?.autoSelectFastest === true);
  const running = useAppStore((s) => s.connectionStatus?.proxyCore?.running === true);
  const apply = useAppStore((s) => s.applyLatencyResults);

  useEffect(() => {
    if (!auto || !running) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const byTag = await api.proxy.getKernelDelays();
        if (cancelled) return;
        const st = useAppStore.getState();
        const servers = st.config?.servers ?? [];
        const results: Record<string, number> = {};
        for (const s of servers) {
          const d = byTag[s.name];
          if (typeof d === 'number') results[s.id] = d;
        }
        if (Object.keys(results).length > 0) apply(results);
      } catch {
        /* 读不到就维持现状：不影响代理，也不清空已有数字 */
      }
    };

    void tick();
    const timer = setInterval(tick, SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [auto, running, apply]);
}
