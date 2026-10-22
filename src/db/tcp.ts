import { concat, isIpLiteral } from './bytes';

interface CfSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): Promise<void> | void;
  startTls(options?: { expectedServerHostname?: string }): CfSocket;
}

type SecureTransport = 'off' | 'starttls';

export class TcpConn {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private extra = new Uint8Array(0);

  private constructor(private socket: CfSocket) {}

  static async open(host: string, port: number, secureTransport: SecureTransport = 'off'): Promise<TcpConn> {
    const { connect } = await import('cloudflare:sockets') as {
      connect: (address: { hostname: string; port: number }, options?: { secureTransport?: SecureTransport }) => CfSocket;
    };
    const socket = connect(
      { hostname: host.replace(/^\[|\]$/g, ''), port },
      { secureTransport }
    );
    try {
      await socket.opened;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/proxy request failed|cannot connect|Network connection lost/i.test(message)) {
        throw new Error('Cloudflare 连不上这个数据库地址，请确认地址、端口和防火墙。');
      }
      throw error;
    }
    const conn = new TcpConn(socket);
    conn.attach();
    return conn;
  }

  private attach(): void {
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
  }

  async readExactly(length: number): Promise<Uint8Array> {
    while (this.extra.length < length) {
      const reader = this.reader;
      if (!reader) throw new Error('数据库连接已关闭');
      let done = false;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/Cannot read properties of null|is closing|closed/i.test(message)) throw new Error('数据库连接已关闭');
        throw error;
      }
      if (done || !value) throw new Error('数据库连接已关闭');
      this.extra = concat([this.extra, value]);
    }
    const out = this.extra.slice(0, length);
    this.extra = this.extra.slice(length);
    return out;
  }

  async write(data: Uint8Array): Promise<void> {
    try {
      await this.writer!.write(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/WritableStream|is closing/i.test(message)) throw new Error('数据库连接已关闭');
      throw error;
    }
  }

  async startTls(hostname: string): Promise<void> {
    if (this.extra.length > 0) throw new Error('加密握手前收到了意外数据');
    this.reader?.releaseLock();
    this.writer?.releaseLock();
    const options = isIpLiteral(hostname) ? {} : { expectedServerHostname: hostname };
    this.socket = this.socket.startTls(options);
    this.attach();
  }

  close(): void {
    try {
      const result = this.socket.close();
      if (result) void Promise.resolve(result).catch(() => undefined);
    } catch { /* already closing */ }
  }
}

export async function withDbTimeout<T>(work: Promise<T>, conn: TcpConn, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      conn.close();
      reject(new Error('连接数据库超时'));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
