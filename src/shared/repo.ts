/**
 * repo.ts — 本仓库身份的唯一真值。
 *
 * 背景：这是 upstream `dododook/FlowZ`（sing-box 内核）的 mihomo 改造版。此前更新源、托盘外链、
 * 关于页仓库地址、Linux unit 的 Documentation 全部还指向上游 —— 用户点「检查更新」或从 README 下载，
 * 拿到的是 sing-box 版安装包，会以相同 appId 覆盖安装到同一 userData 目录。那是一次灾难性误升级。
 *
 * 现在这些位置统一从这里取，改仓库只改一处；单测断言也引用常量而非硬编码 URL，不会出现「改代码忘改测试」。
 */
export const REPO_OWNER = 'Anji-318';
export const REPO_NAME = 'FlowZ-mihomo';
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
export const REPO_RELEASES_URL = `${REPO_URL}/releases`;

/** GitHub API 的 release 列表端点（应用自更新用；内核/资源下载各有自己的 manifest 源）。 */
export const REPO_RELEASES_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases`;

/** 产品展示名（窗口标题 / 通知 / 安装包名）。与 electron-builder productName 保持一致。 */
export const PRODUCT_NAME = 'FlowZ Mihomo';
/** 应用 ID（Windows AppUserModelID / macOS bundle id / NSIS 升级键）。与 electron-builder appId 一致。 */
export const APP_ID = 'com.flowz.mihomo';
