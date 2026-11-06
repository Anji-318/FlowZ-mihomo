/**
 * user-data-migration.ts — 旧产品名（flowz / FlowZ Clash）→ FlowZ Mihomo 的用户数据迁移。
 *
 * 为什么必须做：本 fork 与上游共用过同一个 appId 与 package.json name，`app.getPath('userData')` 落在
 * `%APPDATA%/flowz`（macOS `~/Library/Application Support/flowz`）。为杜绝与上游互相覆盖，产品名改成
 * 「FlowZ Mihomo」后 userData 随之改名 —— 如果不迁移，老用户升级会「节点、规则、隐私锁密码全部消失」，
 * 这比不隔离更糟。故首启做一次幂等迁移。
 *
 * 迁移策略（只搬「用户资产」，不搬缓存/瞬时状态）：
 *   · 搬：config.json（节点/规则/订阅）、privacy-lock.json（隐私锁口令哈希）、skipped_version.txt、
 *         rules/（外置规则文件）、tailscale/（登录态，否则要重新授权）。
 *   · 不搬：logs/、Cache/、GPUCache/、core-staged/、*.marker.json（系统代理/DNS 的瞬时标记，搬过去会让
 *         「上次异常退出」的清理逻辑误判）、helper token（提权组件会按新路径重建）。
 *
 * 幂等：新目录已有 config.json 或已写过 marker → 直接返回，绝不覆盖用户现有数据。
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** 需要搬迁的相对路径（文件或目录）。缺哪个跳哪个，不视为失败。 */
export const MIGRATED_ENTRIES = [
  'config.json',
  'privacy-lock.json',
  'skipped_version.txt',
  'rules',
  'tailscale',
] as const;

/** 迁移完成标记（写在**新**目录），避免每次启动重复扫描。 */
export const MIGRATION_MARKER = '.migrated-from-flowz';

export interface MigrationResult {
  migrated: boolean;
  /** 实际拷贝成功的条目（诊断日志用）。 */
  copied: string[];
  /** 旧目录路径（无论是否存在都回填，便于日志定位）。 */
  from: string;
  to: string;
  reason?: 'no-legacy-dir' | 'already-migrated' | 'new-dir-has-config' | 'error';
}

/**
 * 执行迁移。必须在使用 userData 读取配置**之前**调用（index.ts 的 initUserDataPath() 之后）。
 *
 * @param legacyDir 旧数据目录；不传则按 Electron 约定取 `path.dirname(userData)/<旧名>`。
 */
export function migrateLegacyUserData(legacyDir?: string): MigrationResult {
  const to = app.getPath('userData');
  const from = legacyDir ?? path.join(path.dirname(to), 'flowz');
  const result: MigrationResult = { migrated: false, copied: [], from, to };

  try {
    if (path.resolve(from) === path.resolve(to)) {
      return { ...result, reason: 'already-migrated' };
    }
    if (fs.existsSync(path.join(to, MIGRATION_MARKER))) {
      return { ...result, reason: 'already-migrated' };
    }
    // 新目录已有配置 → 用户已在新版用过（或本身是新装），绝不覆盖。
    if (fs.existsSync(path.join(to, 'config.json'))) {
      return { ...result, reason: 'new-dir-has-config' };
    }
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
      return { ...result, reason: 'no-legacy-dir' };
    }

    fs.mkdirSync(to, { recursive: true });
    for (const entry of MIGRATED_ENTRIES) {
      const src = path.join(from, entry);
      const dst = path.join(to, entry);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      try {
        fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
        result.copied.push(entry);
      } catch {
        // 单条失败不阻断其它资产（例如 rules/ 里某个文件被占用）。
      }
    }
    fs.writeFileSync(
      path.join(to, MIGRATION_MARKER),
      `migrated from ${from} at ${new Date().toISOString()}\n`,
      'utf-8'
    );
    result.migrated = result.copied.length > 0;
    return result;
  } catch {
    return { ...result, reason: 'error' };
  }
}
