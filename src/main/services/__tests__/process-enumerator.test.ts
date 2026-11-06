/**
 * ProcessEnumerator 回归（移植上游 #375）：
 * macOS GUI 应用常以 C locale 启动，/bin/ps 会把中文路径逐字节转义成 `M-fM-...`，
 * 解码后无法还原。锁定子进程必须收到 UTF-8 locale；同时验证「过滤自身内核」对 mihomo 生效
 * （fork 把内核换成 mihomo 后，选择器里不该出现自己的核进程）。
 */
import { execFile } from 'child_process';
import { listSystemProcesses } from '../ProcessEnumerator';

jest.mock('child_process', () => ({ execFile: jest.fn() }));

const execFileMock = execFile as unknown as jest.Mock;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

describe('ProcessEnumerator macOS UTF-8 paths', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterAll(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('以 UTF-8 locale 运行 ps，保留中文可执行名和路径', async () => {
    const processPath = '/Applications/汽水音乐.app/Contents/MacOS/汽水音乐';
    execFileMock.mockImplementation(
      (
        cmd: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv },
        callback: (error: Error | null, stdout: string) => void
      ) => {
        expect(cmd).toBe('/bin/ps');
        expect(args).toEqual(['-axo', 'comm=']);
        expect(options.env).toEqual(
          expect.objectContaining({ LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' })
        );
        callback(null, `${processPath}\n`);
      }
    );

    await expect(listSystemProcesses()).resolves.toEqual([
      { name: '汽水音乐', path: processPath, count: 1 },
    ]);
  });

  it('过滤 mihomo 自身内核，避免把代理核列进可选进程', async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void
      ) => {
        callback(null, '/Applications/FlowZ Mihomo.app/Contents/Resources/mihomo\n/usr/bin/safari\n');
      }
    );

    const list = await listSystemProcesses();
    expect(list.map((p) => p.name)).toEqual(['safari']);
  });
});
