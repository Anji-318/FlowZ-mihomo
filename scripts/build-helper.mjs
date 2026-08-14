#!/usr/bin/env node
/**
 * build-helper.mjs — 交叉编译 FlowZ 提权 helper（Go）：
 *   macOS（helper/，纯 stdlib，arm64+x64）+ Windows（helper-win/，winio+x-sys，amd64）
 *   + Linux（helper-linux/，纯 stdlib，钉 amd64 对齐 --x64 打包）。
 *
 * 由原 build-helper.sh 改写为 Node 版：原脚本在 Windows 无 Git Bash 时 `bash` 会落到 WSL
 * （报「没有已安装的分发」），npm script 跨平台必须走 node。产物与目录约定不变：
 * 随 electron-builder extraResources（resources/mac-${arch} / win / linux）打进安装包。
 *
 * 语义与 sh 版一致：未找到 go 工具链时——REQUIRE_HELPER=1 报错终止（发布构建），否则告警跳过
 * （本地开发回退 osascript/看护脚本）。
 */
import { chmodSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_NAME = 'com.flowz.helper';

/** 同步执行 go build；非零退出即终止（保留 stderr 原样输出）。 */
function goBuild({ src, out, goos, goarch, vendor = false, chmod = false }) {
  console.log(`[build-helper] ${goos}-${goarch} → ${out}`);
  mkdirSync(dirname(out), { recursive: true });
  const args = [
    'build',
    ...(vendor ? ['-mod=vendor'] : []),
    '-trimpath', '-ldflags=-s -w', '-o', out, '.',
  ];
  const r = spawnSync(process.platform === 'win32' ? 'go.exe' : 'go', args, {
    cwd: src,
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
    stdio: 'inherit',
    shell: false,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error(`[build-helper] go build 失败（${goos}/${goarch}，退出码 ${r.status}）`);
    process.exit(r.status ?? 1);
  }
  if (chmod) chmodSync(out, 0o755);
}

// go 工具链探测：Windows 上 spawnSync('go') 经 PATHEXT 解析 go.exe，无需 shell。
const probe = spawnSync(process.platform === 'win32' ? 'go.exe' : 'go', ['version'], { stdio: 'pipe' });
if (probe.error || probe.status !== 0) {
  if (process.env.REQUIRE_HELPER) {
    console.error('[build-helper] REQUIRE_HELPER 已设但未找到 go 工具链 —— 提权 helper 是发布必需组件，终止以避免静默发布无 helper 的包');
    process.exit(1);
  }
  console.warn('[build-helper] 未找到 go 工具链，跳过 helper 构建（提权 helper 不打包，运行时回退看护脚本；完整发布包请先安装 Go：https://go.dev/dl/）');
  process.exit(0);
}

// macOS helper（helper/，纯 stdlib，两架构）
for (const [arch, goarch] of [['arm64', 'arm64'], ['x64', 'amd64']]) {
  goBuild({
    src: join(ROOT, 'helper'),
    out: join(ROOT, `resources/mac-${arch}/${OUT_NAME}`),
    goos: 'darwin', goarch, chmod: true,
  });
}

// Windows 提权服务 helper（独立 module，含 vendor/ → 离线构建）
const winSrc = join(ROOT, 'helper-win');
if (existsSync(winSrc)) {
  goBuild({
    src: winSrc,
    out: join(ROOT, 'resources/win/com.flowz.helper.exe'),
    goos: 'windows', goarch: 'amd64', vendor: true,
  });
}

// Linux 提权 helper（纯 stdlib，钉 amd64 对齐 electron-builder --x64；跨架构另加 GOARCH 腿）
const linuxSrc = join(ROOT, 'helper-linux');
if (existsSync(linuxSrc)) {
  const goarch = process.env.LINUX_GOARCH || 'amd64';
  goBuild({
    src: linuxSrc,
    out: join(ROOT, 'resources/linux/flowz-helper-linux'),
    goos: 'linux', goarch, chmod: true,
  });
}

console.log('[build-helper] done');
