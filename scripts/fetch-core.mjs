#!/usr/bin/env node
/**
 * fetch-core.mjs — 按 core-manifest.json 的 bundledCoreVersion 从 MetaCubeX/mihomo 官方 release
 * 下载各平台 mihomo 二进制到 resources/{平台}/，供 electron-builder extraResources 随安装包打包
 * （与 libcronet/dashboard 同「现拉现打、不入库」模式）。
 *
 * 用法：node scripts/fetch-core.mjs [--force] [--android]
 *
 *   默认拉 4 个桌面平台（linux/win/mac-x64/mac-arm64），供 electron-builder extraResources。
 *   `--android` 改拉 4 个 Android ABI（arm64-v8/armv7/amd64/386）→ resources/android-<abi>/mihomo。
 *   Android 核不随桌面安装包分发（Electron 不能跑在 Android 上），是给移动端壳（见
 *   docs/ANDROID.md）备的钉版供应链入口；与桌面核同版本、同双 sha256 pin。
 *
 * 完整性 pin：core-manifest.json 的 coreArchiveSha256 是「下载的压缩包(.gz/.zip)本体」的 sha256，
 * coreBinarySha256 是「落地二进制本体」的 sha256。下载后逐字节校验，不符即 fail-fast。
 *
 * 资产形态（mihomo 与 sing-box 不同）：
 *   · linux / darwin：单文件 gzip（mihomo-<os>-<arch>-v<ver>.gz），gunzip 后即为可执行核；
 *   · windows：zip 内含 mihomo-windows-amd64.exe，落地为 mihomo.exe。
 *
 * 跨平台一致：全 4 平台核一律下载（支持 Linux 上交叉构建）；已落地且 sha 与 coreBinarySha256 相符
 * 则跳过（换版本无需 --force）；`--force` 仅用于无条件重拉。
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
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { createGunzip } from 'zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 版本耦合的唯一真源：与 TS 主进程共享同一份 manifest，升级核心只需改 core-manifest.json。
const manifest = JSON.parse(readFileSync(join(ROOT, 'src/shared/core-manifest.json'), 'utf-8'));
const VERSION = manifest.bundledCoreVersion; // 资产名带 v 前缀；release tag 亦带 v（如 v1.19.29）
const SHA = manifest.coreArchiveSha256 || {};
const BIN_SHA = manifest.coreBinarySha256 || {};
const REPO = manifest.coreRepo || 'MetaCubeX/mihomo';
const FORCE = process.argv.includes('--force');
const ANDROID = process.argv.includes('--android');

// resources 目标目录 ← 官方资产名(压缩包) → 落地二进制名 → coreArchiveSha256 key。
// mihomo 官方资产：linux/darwin 为单文件 .gz（gunzip 即核本体）；windows 为 .zip 内含
// mihomo-windows-amd64.exe。
const DESKTOP_TARGETS = [
  {
    dir: 'resources/linux',
    asset: `mihomo-linux-amd64-v${VERSION}.gz`,
    bin: 'mihomo',
    key: 'linux',
  },
  {
    dir: 'resources/win',
    asset: `mihomo-windows-amd64-v${VERSION}.zip`,
    bin: 'mihomo.exe',
    key: 'win',
  },
  {
    dir: 'resources/mac-x64',
    asset: `mihomo-darwin-amd64-v${VERSION}.gz`,
    bin: 'mihomo',
    key: 'mac-x64',
  },
  {
    dir: 'resources/mac-arm64',
    asset: `mihomo-darwin-arm64-v${VERSION}.gz`,
    bin: 'mihomo',
    key: 'mac-arm64',
  },
];

// Android 四 ABI（官方资产均单文件 .gz，gunzip 即 ELF，interpreter=/system/bin/linker64）。
// key 命名与 ABI 对齐（arm64-v8/armv7/amd64/386 → android-arm64/-armv7/-x64/-x86）。
const ANDROID_TARGETS = [
  {
    dir: 'resources/android-arm64',
    asset: `mihomo-android-arm64-v8-v${VERSION}.gz`,
    bin: 'mihomo',
    key: 'android-arm64',
  },
  {
    dir: 'resources/android-armv7',
    asset: `mihomo-android-armv7-v${VERSION}.gz`,
    bin: 'mihomo',
    key: 'android-armv7',
  },
  {
    dir: 'resources/android-x64',
    asset: `mihomo-android-amd64-v${VERSION}.gz`,
    bin: 'mihomo',
    key: 'android-x64',
  },
  {
    dir: 'resources/android-x86',
    asset: `mihomo-android-386-v${VERSION}.gz`,
    bin: 'mihomo',
    key: 'android-x86',
  },
];

const TARGETS = ANDROID ? ANDROID_TARGETS : DESKTOP_TARGETS;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 从解压目录里找目标二进制（zip 容错：可能平铺也可能带顶层目录）。 */
function findBin(extractDir, binName) {
  for (const n of readdirSync(extractDir)) {
    const cand = join(extractDir, n, binName);
    if (existsSync(cand)) return cand;
  }
  const flat = join(extractDir, binName);
  return existsSync(flat) ? flat : null;
}

let ok = 0;
let failed = 0;
let unverified = 0;
for (const t of TARGETS) {
  const absDir = join(ROOT, t.dir);
  const dest = join(absDir, t.bin);

  // 已落地时的处置：拿磁盘上的二进制算 sha 比对 coreBinarySha256——对得上才 skip (verified)，
  // 对不上视作陈旧重新下载（换 bundledCoreVersion 后无需 --force）。
  const wantBin = (BIN_SHA[t.key] || '').replace(/^sha256:/, '');
  if (existsSync(dest) && !FORCE) {
    if (wantBin) {
      const gotBin = sha256(dest);
      if (gotBin === wantBin) {
        console.log(`skip (verified): ${t.dir}/${t.bin} (bin sha ${gotBin.slice(0, 12)}…)`);
        ok++;
        continue;
      }
      console.log(
        `stale: ${t.dir}/${t.bin} 与 coreBinarySha256 不符（磁盘 ${gotBin.slice(0, 12)}… ≠ pin ${wantBin.slice(0, 12)}…）→ 重新下载`
      );
    } else {
      console.log(
        `skip (unverified): ${t.dir}/${t.bin} — core-manifest.json 缺 coreBinarySha256[${t.key}]，无法确认磁盘上是否就是 ${VERSION}；若刚改 bundledCoreVersion 须加 --force`
      );
      ok++;
      unverified++;
      continue;
    }
  }

  // 完整性 pin 是供应链防护核心：缺 pin 直接 fail（绝不无校验拉可执行核）。
  const want = (SHA[t.key] || '').replace(/^sha256:/, '');
  if (!want) {
    console.error(
      `  FAILED ${t.key}: core-manifest.json 缺 coreArchiveSha256[${t.key}] pin → 拒绝无完整性校验拉取（换版本须同步补）`
    );
    failed++;
    continue;
  }

  mkdirSync(absDir, { recursive: true });
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${t.asset}`;
  const work = mkdtempSync(join(tmpdir(), 'flowz-core-'));
  try {
    const archive = join(work, t.asset);
    console.log(`downloading ${t.asset} ...`);
    // 下载候选：GitHub 直连 → gh-proxy 镜像（可用 FLOWZ_GH_MIRROR 覆盖镜像前缀）。
    // 国内网络直连 GitHub 常因 schannel 吊销检查脱机（CRYPT_E_REVOCATION_OFFLINE）或
    // 连接重置失败；镜像回退 + win32 下 --ssl-no-revoke 重试兜底。完整性由下方 sha256
    // pin 校验兜底，镜像只做传输层，不影响供应链安全。
    const mirror = (process.env.FLOWZ_GH_MIRROR || 'https://gh-proxy.com/').replace(/\/?$/, '/');
    const attempts = [
      { label: 'github 直连', u: url, noRevoke: false },
      // win32 schannel 吊销服务器脱机时的直连重试（仅 Schannel 认此 flag，其他平台不加）
      ...(process.platform === 'win32' ? [{ label: 'github 直连(--ssl-no-revoke)', u: url, noRevoke: true }] : []),
      { label: `镜像 ${mirror}`, u: mirror + url, noRevoke: process.platform === 'win32' },
    ];
    let downloaded = false;
    let lastErr = '';
    for (const a of attempts) {
      try {
        console.log(`  尝试 ${a.label} ...`);
        // -fL：失败返回非零 + 跟随重定向；--retry 抗瞬时抖动。
        execFileSync(
          'curl',
          ['-fL', '--retry', '3', ...(a.noRevoke ? ['--ssl-no-revoke'] : []), '-o', archive, a.u],
          { stdio: 'inherit' }
        );
        downloaded = true;
        break;
      } catch (e) {
        lastErr = e.message;
        console.error(`  ${a.label} 失败，切换下一候选`);
      }
    }
    if (!downloaded) throw new Error(`全部下载候选失败：${lastErr}`);

    // 完整性校验①：压缩包本体 sha256。fail-fast 于解压前。
    const got = sha256(archive);
    if (got !== want) {
      throw new Error(`压缩包 sha256 不符：期望 ${want}，实得 ${got}（版本漂移 / 投毒 / 截断）`);
    }

    // 取出核二进制：单文件 .gz 直接 gunzip；.zip 解压后找 windows 可执行名。
    let binPath;
    if (t.asset.endsWith('.gz')) {
      binPath = join(work, 'core-bin');
      await pipeline(createReadStream(archive), createGunzip(), createWriteStream(binPath));
    } else {
      const extractDir = join(work, 'x');
      mkdirSync(extractDir, { recursive: true });
      // Windows 无 unzip 命令；Win10+ 自带 bsdtar（C:\Windows\System32\tar.exe）可解 zip。
      if (process.platform === 'win32') {
        execFileSync('tar', ['-xf', archive, '-C', extractDir], { stdio: 'inherit' });
      } else {
        execFileSync('unzip', ['-q', '-o', archive, '-d', extractDir], { stdio: 'inherit' });
      }
      // mihomo windows 资产内含 mihomo-windows-amd64.exe
      binPath = findBin(extractDir, 'mihomo-windows-amd64.exe') || findBin(extractDir, t.bin);
    }
    if (!binPath) throw new Error(`解压产物未找到 mihomo 二进制（官方资产结构可能变化）`);

    // 原子落地：拷到 .tmp → chmod（unix 可执行）→ rename 顶替。
    const tmpDest = `${dest}.tmp`;
    rmSync(tmpDest, { force: true });
    copyFileSync(binPath, tmpDest);
    if (t.bin !== 'mihomo.exe') chmodSync(tmpDest, 0o755);

    // 完整性校验②：落地二进制本体 sha，并为下次运行的 verified-skip 留锚。
    const gotBin = sha256(tmpDest);
    if (wantBin && gotBin !== wantBin) {
      rmSync(tmpDest, { force: true });
      throw new Error(
        `二进制 sha256 不符：期望 ${wantBin}，实得 ${gotBin}（官方资产内容变化 / 取错文件）`
      );
    }
    renameSync(tmpDest, dest);
    console.log(
      `  ok: ${t.dir}/${t.bin} (archive sha ${got.slice(0, 12)}…, bin sha ${gotBin}${wantBin ? '' : ' ← 请抄进 coreBinarySha256'})`
    );
    ok++;
  } catch (e) {
    console.error(`  FAILED ${t.key}: ${e.message}`);
    failed++;
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(`${dest}.tmp`, { force: true });
  }
}

console.log(
  `\nmihomo cores: ${ok} ready, ${failed} failed` +
    (unverified > 0
      ? ` — 其中 ${unverified} 个未经校验，磁盘上未必是 ${VERSION}（补 coreBinarySha256 或加 --force）`
      : ` (version ${VERSION}).`)
);
process.exit(failed > 0 ? 1 : 0);
