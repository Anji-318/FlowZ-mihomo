#!/usr/bin/env node
/**
 * bump-core.mjs — 一条命令把随包内核升到指定 mihomo 版本，并自动回填「双 sha256 pin」。
 *
 * 用法：node scripts/bump-core.mjs 1.19.33 [--android] [--dry-run]
 *
 * 为什么需要它：core-manifest.json 有 8 个平台 × 2 个 sha256（压缩包 + 落地二进制），
 * 手工升级必然抄错或漏抄（漏 coreBinarySha256 会让 fetch-core 退化为「不校验直接跳过」，
 * 这正是升级链最危险的静默失败）。本脚本把「取版本 → 校验官方 digest → 解压 → 算二进制 sha
 * → 写回 manifest → 落地 resources/」全链路自动化，任何一步不符即 fail-fast。
 *
 * 完整性语义：
 *   ① 官方 API 的 asset.digest（GitHub 计算）先校验压缩包，防传输层篡改；
 *   ② 解压后再算二进制 sha 写进 manifest，供 fetch-core 做「已落地是否陈旧」判定。
 * 两者都写进 manifest，fetch-core 才会走 verified-skip 而非 unverified-skip。
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { createGunzip } from 'zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'src/shared/core-manifest.json');

const args = process.argv.slice(2);
const VERSION = (args.find((a) => !a.startsWith('--')) || '').replace(/^v/, '');
const ONLY_ANDROID = args.includes('--android');
// 默认桌面 4 平台 + Android 4 ABI 全量；--desktop / --android 可分开跑（桌面安装包只需要前 4 个，
// 网络差时可先落桌面、再补 Android，manifest 按 key 合并，不会把没跑的平台的 pin 写坏）。
const ONLY_DESKTOP = args.includes('--desktop');
const DRY_RUN = args.includes('--dry-run');

if (!/^\d+\.\d+\.\d+/.test(VERSION)) {
  console.error('用法: node scripts/bump-core.mjs <version> [--desktop|--android] [--dry-run]');
  console.error('  版本号形如 1.19.33（不带 v 前缀）');
  process.exit(2);
}

/** 与 fetch-core.mjs 的 DESKTOP_TARGETS / ANDROID_TARGETS 保持一致。 */
const DESKTOP = [
  { key: 'linux', dir: 'resources/linux', asset: `mihomo-linux-amd64-v${VERSION}.gz`, bin: 'mihomo' },
  { key: 'win', dir: 'resources/win', asset: `mihomo-windows-amd64-v${VERSION}.zip`, bin: 'mihomo.exe' },
  { key: 'mac-x64', dir: 'resources/mac-x64', asset: `mihomo-darwin-amd64-v${VERSION}.gz`, bin: 'mihomo' },
  { key: 'mac-arm64', dir: 'resources/mac-arm64', asset: `mihomo-darwin-arm64-v${VERSION}.gz`, bin: 'mihomo' },
];
const ANDROID = [
  { key: 'android-arm64', dir: 'resources/android-arm64', asset: `mihomo-android-arm64-v8-v${VERSION}.gz`, bin: 'mihomo' },
  { key: 'android-armv7', dir: 'resources/android-armv7', asset: `mihomo-android-armv7-v${VERSION}.gz`, bin: 'mihomo' },
  { key: 'android-x64', dir: 'resources/android-x64', asset: `mihomo-android-amd64-v${VERSION}.gz`, bin: 'mihomo' },
  { key: 'android-x86', dir: 'resources/android-x86', asset: `mihomo-android-386-v${VERSION}.gz`, bin: 'mihomo' },
];
const TARGETS = ONLY_ANDROID ? ANDROID : ONLY_DESKTOP ? DESKTOP : [...DESKTOP, ...ANDROID];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 解 zip。Windows 上有两个坑（都实测踩过）：
 *   ① Git Bash 的 PATH 里 GNU tar 排在前面，它不认 zip（"This does not look like a tar archive"）；
 *   ② npm script 走 cmd/pwsh 时才是 System32\tar.exe（bsdtar，能解 zip）。
 * 故这里按「bsdtar 全路径 → unzip」顺序兜底，不依赖调用方 shell。
 */
function extractZip(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const bsdtar = join(sysRoot, 'System32', 'tar.exe');
  const attempts = [];
  if (process.platform === 'win32' && existsSync(bsdtar)) {
    attempts.push(() => execFileSync(bsdtar, ['-xf', archivePath, '-C', destDir], { stdio: 'pipe' }));
  }
  attempts.push(() => execFileSync('unzip', ['-q', '-o', archivePath, '-d', destDir], { stdio: 'pipe' }));
  let lastErr;
  for (const run of attempts) {
    try {
      run();
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`zip 解压失败（bsdtar/unzip 均不可用）：${lastErr?.message ?? ''}`);
}

/** 递归找目标文件名（zip 内可能平铺也可能带顶层目录）。 */
function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

/** 带超时的 fetch（Node 18+ 全局 fetch），仅用于 api.github.com 的小 JSON。 */
async function fetchWithTimeout(url, { timeoutMs = 60_000, accept = '*/*' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'flowz-bump-core', accept },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下载单个资产：镜像优先、直连兜底（与 fetch-core.mjs 同策略）。
 * 实测国内直连 GitHub release 仅 ~15KB/s（22MB 需半小时+），gh-proxy 镜像 ~1.6MB/s。
 * 完整性由官方 API 的 asset.digest 兜底 —— 镜像只做传输层，无法替换内容。
 */
function downloadAsset(asset, dest) {
  const mirror = (process.env.FLOWZ_GH_MIRROR || 'https://gh-proxy.com/').replace(/\/?$/, '/');
  const direct = asset.browser_download_url;
  const attempts = [
    { label: `镜像 ${mirror}`, url: mirror + direct },
    { label: 'github 直连', url: direct },
  ];
  let lastErr = '';
  for (const a of attempts) {
    try {
      console.log(`  下载中（${a.label}）…`);
      execFileSync('curl', ['-fL', '--retry', '2', '--connect-timeout', '20', '-o', dest, a.url], {
        stdio: 'pipe',
        timeout: 600_000,
      });
      return;
    } catch (e) {
      lastErr = e.message;
      rmSync(dest, { force: true });
      console.warn(`  ${a.label} 失败，切换下一候选`);
    }
  }
  throw new Error(`全部下载候选失败：${lastErr}`);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
const repo = manifest.coreRepo || 'MetaCubeX/mihomo';

console.log(`内核升级目标: ${repo} v${VERSION}${DRY_RUN ? '（dry-run，不落盘）' : ''}`);

// ① 取官方 release 资产清单（含 GitHub 计算的 digest，先于下载的信任锚）。
const relRes = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/tags/v${VERSION}`, {
  accept: 'application/vnd.github+json',
});
if (!relRes.ok) {
  console.error(`获取 release v${VERSION} 失败: HTTP ${relRes.status}`);
  process.exit(1);
}
const release = await relRes.json();
const assets = new Map((release.assets || []).map((a) => [a.name, a]));
console.log(`release 资产 ${assets.size} 个，发布时间 ${release.published_at}`);

const nextArchiveSha = {};
const nextBinarySha = {};
let failed = 0;

for (const t of TARGETS) {
  const asset = assets.get(t.asset);
  if (!asset) {
    console.error(`  FAILED ${t.key}: release 里没有资产 ${t.asset}`);
    console.error(`  可用资产示例: ${[...assets.keys()].slice(0, 6).join(', ')} …`);
    failed++;
    continue;
  }
  const expectedArchive = String(asset.digest || '').replace(/^sha256:/, '').toLowerCase();

  const work = mkdtempSync(join(tmpdir(), 'flowz-bump-'));
  try {
    console.log(`\n[${t.key}] ${t.asset} (${(asset.size / 1048576).toFixed(1)} MB)`);
    const archivePath = join(work, t.asset);
    downloadAsset(asset, archivePath);

    const archiveBuf = readFileSync(archivePath);
    const gotArchive = sha256(archiveBuf);
    if (expectedArchive && gotArchive !== expectedArchive) {
      throw new Error(`压缩包 digest 不符：官方 ${expectedArchive.slice(0, 16)}… ≠ 实得 ${gotArchive.slice(0, 16)}…`);
    }
    if (!expectedArchive) {
      console.warn('  ⚠ 官方未提供 digest，仅能记录本地计算值（供应链保障降级）');
    }

    // ② 解压取核本体，算二进制 sha（这才是 fetch-core 的 verified-skip 锚）。
    let binPath;
    if (t.asset.endsWith('.gz')) {
      binPath = join(work, 'core-bin');
      await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(binPath));
    } else {
      const extractDir = join(work, 'x');
      extractZip(archivePath, extractDir);
      for (const name of ['mihomo-windows-amd64.exe', t.bin]) {
        const hit = findFile(extractDir, name);
        if (hit) {
          binPath = hit;
          break;
        }
      }
    }
    if (!binPath || !existsSync(binPath)) throw new Error('解压后未找到 mihomo 二进制（官方资产结构可能变化）');

    const binBuf = readFileSync(binPath);
    const gotBinary = sha256(binBuf);
    nextArchiveSha[t.key] = gotArchive;
    nextBinarySha[t.key] = gotBinary;
    console.log(`  archive sha256: ${gotArchive}`);
    console.log(`  binary  sha256: ${gotBinary}`);

    if (!DRY_RUN) {
      const absDir = join(ROOT, t.dir);
      mkdirSync(absDir, { recursive: true });
      const dest = join(absDir, t.bin);
      const tmpDest = `${dest}.tmp`;
      rmSync(tmpDest, { force: true });
      copyFileSync(binPath, tmpDest);
      if (t.bin !== 'mihomo.exe') chmodSync(tmpDest, 0o755);
      renameSync(tmpDest, dest);
      console.log(`  已落地 ${t.dir}/${t.bin}`);
    }
  } catch (e) {
    console.error(`  FAILED ${t.key}: ${e.message}`);
    failed++;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个平台失败，manifest 未改动（避免半新半旧的 pin 组合）。`);
  process.exit(1);
}

if (!DRY_RUN) {
  // ③ 只覆盖本次涉及的 key，其余平台（例如只跑 --android）保持原值不变。
  const mergedArchive = { ...(manifest.coreArchiveSha256 || {}), ...nextArchiveSha };
  const mergedBinary = { ...(manifest.coreBinarySha256 || {}), ...nextBinarySha };
  const next = {
    ...manifest,
    bundledCoreVersion: VERSION,
    coreArchiveSha256: mergedArchive,
    coreBinarySha256: mergedBinary,
  };
  // 保持既有字段顺序（coreName/coreRepo/version/cronet/两个 sha 块），避免无意义 diff 噪声。
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  console.log(`\n已写回 ${MANIFEST_PATH}（bundledCoreVersion=${VERSION}）`);
}

console.log(`\n下一步：npm run fetch:core   # 用新 pin 校验/补齐 resources 下的内核`);
