/**
 * update-digest.ts — 应用更新包的完整性校验（sha256）。
 *
 * 为什么需要：内核更新一直有 digest 门（CoreUpdateService 取 GitHub asset.digest，取不到就拒装），
 * 但**应用自身**的安装包此前只校验 content-length —— 长度对得上就执行 NSIS/挂 DMG。
 * 项目又内置 gh-proxy 镜像下载（镜像节点是额外信任面），一旦镜像被投毒，用户拿到的是「长度正确
 * 的任何 exe」。所以把 digest 校验补到与应用更新同一入口，且镜像/直连一致生效。
 *
 * 信任锚：digest 由 GitHub API（api.github.com，TLS）随 release 一起下发，下载走的是 CDN/镜像。
 * 只要校验的是 API 给的 digest，镜像就只能做传输层，无法替换内容。
 *
 * 语义：
 *   - digest 缺失（老 release / API 未回填）→ 返回 'skipped'，由调用方决定是否放行（当前放行但记 warn）。
 *   - digest 存在而实文件不符 → 删残件 + 抛错（调用方按下载失败处理，可重试/换镜像）。
 */
import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';

export type DigestVerdict = 'verified' | 'skipped';

/** 归一化 GitHub 的 `sha256:<hex>` 或裸 hex；非法值返回 null（宁可当缺失，也不做半吊子校验）。 */
export function normalizeSha256Digest(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.trim().replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** 流式计算文件 sha256（安装包 100–160MB，避免 readFileSync 整包进内存）。 */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 校验下载好的安装包。
 * @returns 'verified' 已校验通过；'skipped' 调用方未提供 digest，未校验
 * @throws 文件读取失败，或 digest 不符（抛错前删除残件，避免用户手动点到坏包）
 */
export async function verifyUpdateDigest(
  filePath: string,
  rawDigest: unknown
): Promise<DigestVerdict> {
  const expected = normalizeSha256Digest(rawDigest);
  if (!expected) return 'skipped';

  const actual = await sha256File(filePath);
  if (actual !== expected) {
    await fs.unlink(filePath).catch(() => {
      /* 删不掉也不能让坏包留下被误用 */
    });
    throw new Error(
      `更新包完整性校验失败：期望 sha256 ${expected.slice(0, 16)}…，实得 ${actual.slice(0, 16)}…（已删除，疑似镜像投毒或传输损坏）`
    );
  }
  return 'verified';
}
