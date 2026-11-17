// A Pixera native API connection: JSON-RPC 2.0 over TCP, framed the way Pixera's "JSON/TCP" API protocol
// frames it: the four bytes "pxr1", the body length as a 32-bit little-endian number, then the JSON body.
// (Pixera's other TCP mode, "JSON/TCP(dl)", ends each message with the delimiter "0xPX" instead; the
// module uses the framed mode, which is Pixera's default.)
//
// One socket per director, opened on the first request and kept open; requests are matched to replies by
// id. A request that gets no reply within the timeout rejects, and a dropped socket rejects everything
// still waiting, so the next poll opens a fresh one.
import net from 'node:net';

export const HEADER = Buffer.from('pxr1', 'ascii');
export const DEFAULT_PORT = 1400;

export class PixeraError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

export function frame(body: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(body), 'utf8');
  const head = Buffer.alloc(8);
  HEADER.copy(head, 0);
  head.writeUInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

/** Splits a byte stream into framed messages. Returns the messages and whatever is left over. */
export function unframe(buf: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let at = 0;
  while (buf.length - at >= 8) {
    if (!buf.subarray(at, at + 4).equals(HEADER)) {
      // Not Pixera's framing: give up on this buffer rather than guess where the next message starts.
      throw new PixeraError('not a Pixera API reply (no pxr1 header)');
    }
    const len = buf.readUInt32LE(at + 4);
    if (buf.length - at - 8 < len) break;
    messages.push(buf.subarray(at + 8, at + 8 + len).toString('utf8'));
    at += 8 + len;
  }
  return { messages, rest: buf.subarray(at) };
}

interface Waiting {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface Rpc {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

export class PixeraClient implements Rpc {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private waiting = new Map<number, Waiting>();
  private closed = false;

  constructor(
    readonly host: string,
    readonly port = DEFAULT_PORT,
    private timeoutMs = 3000
  ) {}

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new PixeraError('connection closed');
    const socket = await this.connect();
    const id = this.nextId++;
    if (this.nextId > 2_000_000_000) this.nextId = 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new PixeraError(`no answer within ${this.timeoutMs / 1000} s`));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.write(frame({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }));
    });
  }

  close(): void {
    this.closed = true;
    this.drop(new PixeraError('connection closed'));
  }

  private connect(): Promise<net.Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      s.setNoDelay(true);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new PixeraError(`no connection within ${this.timeoutMs / 1000} s`));
      }, this.timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        this.socket = s;
        this.buf = Buffer.alloc(0);
        resolve(s);
      });
      s.on('data', (d) => this.onData(d));
      s.on('error', (e) => {
        clearTimeout(timer);
        if (this.socket !== s) reject(e);
        this.drop(e);
      });
      s.on('close', () => {
        clearTimeout(timer);
        if (this.socket === s) this.drop(new PixeraError('connection closed by Pixera'));
        else reject(new PixeraError('connection closed by Pixera'));
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let out: { messages: string[]; rest: Buffer };
    try {
      out = unframe(this.buf);
    } catch (e) {
      this.drop(e as Error);
      return;
    }
    this.buf = out.rest;
    for (const text of out.messages) {
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      const w = typeof msg?.id === 'number' ? this.waiting.get(msg.id) : undefined;
      if (!w) continue; // monitoring events and replies to requests that already timed out
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new PixeraError(String(msg.error.message ?? 'Pixera returned an error'), msg.error.code));
      else w.resolve(msg.result);
    }
  }

  private drop(e: Error): void {
    const s = this.socket;
    this.socket = null;
    if (s && !s.destroyed) s.destroy();
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.waiting.clear();
  }
}
