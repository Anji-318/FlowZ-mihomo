/**
 * mihomo-ws.ts — 零依赖最小 RFC 6455 WebSocket 客户端。
 *
 * 用途：mihomo Clash API 的 /traffic 与 /connections 推送流（REST 之外仅有的两个 WS 端点）。
 * 项目未引入 `ws` 包，为避免新增依赖，这里实现客户端侧最小子集：
 *   · HTTP Upgrade 握手（Sec-WebSocket-Key / Accept 校验）；
 *   · 帧解析：FIN/opcode、126/127 扩展长度、服务端帧不掩码（容忍掩码）、分片重组；
 *   · 客户端发送必掩码（text/close/ping/pong）；
 *   · ping/pong 保活与被动应答、close 握手。
 * 仅支持 ws://（mihomo external-controller 本地回环，无 TLS）。
 */
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import net from 'net';

export interface SimpleWebSocketOptions {
  /** 额外请求头（如 Authorization: Bearer ...）。 */
  headers?: Record<string, string>;
  /** 握手超时（ms），默认 5000。 */
  handshakeTimeoutMs?: number;
}

export class SimpleWebSocket extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private handshaken = false;
  private closed = false;
  /** 分片重组：累计载荷。 */
  private fragChunks: Buffer[] = [];

  constructor(
    private readonly url: string,
    private readonly options: SimpleWebSocketOptions = {}
  ) {
    super();
  }

  connect(): void {
    const u = new URL(this.url);
    const host = u.hostname;
    const port = Number(u.port || 80);
    const path = `${u.pathname || '/'}${u.search || ''}`;
    const key = randomBytes(16).toString('base64');
    const expectAccept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    const socket = net.createConnection({ host, port });
    this.socket = socket;

    const timeout = setTimeout(() => {
      this.fail(new Error('ws handshake timeout'));
    }, this.options.handshakeTimeoutMs ?? 5000);

    socket.on('connect', () => {
      const extra = Object.entries(this.options.headers || {})
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('');
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          extra +
          `\r\n`
      );
    });

    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk as Buffer]);
      if (!this.handshaken) {
        const idx = this.buffer.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = this.buffer.subarray(0, idx).toString('utf-8');
        this.buffer = this.buffer.subarray(idx + 4);
        clearTimeout(timeout);
        const statusLine = head.split('\r\n')[0] || '';
        if (!/^HTTP\/1\.1 101/.test(statusLine)) {
          this.fail(new Error(`ws handshake rejected: ${statusLine}`));
          return;
        }
        const acceptMatch = head.match(/sec-websocket-accept:\s*(\S+)/i);
        if (!acceptMatch || acceptMatch[1] !== expectAccept) {
          this.fail(new Error('ws handshake accept mismatch'));
          return;
        }
        this.handshaken = true;
        this.emit('open');
      }
      this.drainFrames();
    });

    socket.on('error', (e) => {
      clearTimeout(timeout);
      if (!this.closed) this.emit('error', e);
      this.cleanup();
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      const wasOpen = this.handshaken;
      this.cleanup();
      if (wasOpen) this.emit('close');
      else if (!this.closed) this.emit('error', new Error('ws closed before handshake'));
    });
  }

  /** 发送 text 帧（客户端必掩码）。 */
  send(data: string): void {
    this.writeFrame(0x1, Buffer.from(data, 'utf-8'));
  }

  /** 主动关闭：发 close 帧后结束 socket。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writeFrame(0x8, Buffer.alloc(0));
      this.socket?.end();
    } catch {
      /* ignore */
    }
    this.cleanup();
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('error', e);
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragChunks = [];
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.socket || !this.handshaken) return;
    const mask = randomBytes(4);
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private drainFrames(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        len = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let maskKey: Buffer | null = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      if (maskKey) {
        const unmasked = Buffer.from(payload);
        for (let i = 0; i < unmasked.length; i++) unmasked[i] ^= maskKey[i % 4];
        payload = unmasked;
      }

      // 控制帧：ping → pong；close → 回 close 并结束。
      if (opcode === 0x9) {
        this.writeFrame(0xa, Buffer.from(payload));
        continue;
      }
      if (opcode === 0x8) {
        this.close();
        this.emit('close');
        return;
      }
      if (opcode === 0xa) continue; // pong

      // 数据帧（text/binary/continuation）：分片重组后按 text 派发。
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) {
          this.fragChunks = [Buffer.from(payload)];
        } else {
          this.fragChunks.push(Buffer.from(payload));
        }
        if (fin) {
          const full = Buffer.concat(this.fragChunks);
          this.fragChunks = [];
          this.emit('message', full.toString('utf-8'));
        }
      }
    }
  }
}
