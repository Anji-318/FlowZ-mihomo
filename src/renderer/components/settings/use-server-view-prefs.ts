/**
 * 节点列表的视图偏好（目前只有「隐藏超时节点」）持久化 store。
 *
 * 与 use-server-sort-store 同一套理由：这是渲染端视图态，写 UserConfig 会触发
 * CONFIG_CHANGED → switchMode 重启代理；改个「显不显示超时节点」绝不能断网。
 * 放共享 store 而非组件 useState：节点页工具栏是开关、首页出口下拉是消费方，两处必须同步。
 */
import { create } from 'zustand';

const STORAGE_KEY = 'flowz.serverHideTimeout';

export function loadHideTimeoutPref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    /* 无 localStorage / 隐私模式 → 默认关闭 */
    return false;
  }
}

export function saveHideTimeoutPref(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* 持久化失败不阻断，退化为会话内记忆 */
  }
}

interface ServerViewPrefsState {
  /** 默认 false：装好还没测速时不能把整组节点藏起来。 */
  hideTimeout: boolean;
  setHideTimeout: (value: boolean) => void;
  toggleHideTimeout: () => void;
}

export const useServerViewPrefs = create<ServerViewPrefsState>((set, get) => ({
  hideTimeout: loadHideTimeoutPref(),
  setHideTimeout: (value) => {
    saveHideTimeoutPref(value);
    set({ hideTimeout: value });
  },
  toggleHideTimeout: () => {
    const next = !get().hideTimeout;
    saveHideTimeoutPref(next);
    set({ hideTimeout: next });
  },
}));
