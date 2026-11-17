// Polls every PIXERA director on its own timer, keeps its latest reading and alerts in memory and records
// every change as an event. Listeners hear 'change' after each poll and 'event' for each new event.
// Nothing read from Pixera is written to disk, so a restart or a restored save always starts from what
// the directors say now.
//
// Polling only reads. control() is the one way anything is sent, and the module calls it only for an
// operator's confirmed action.
import { EventEmitter } from 'node:events';
import { PixeraClient, type Rpc } from './pixera/client.js';
import { ControlError, describe, send } from './pixera/control.js';
import { newCache, readDirector, type ReadCache } from './pixera/read.js';
import { evaluate, type Thresholds } from './rules.js';
import type { Alert, ControlRequest, DirectorReading, DirectorView } from './shared.js';

export { ControlError };

export interface DirectorConfig {
  id: string;
  host: string;
  port: number;
  /** Shown instead of the project name. */
  label?: string;
}

export interface MonitorEvent {
  id: number;
  time: number;
  director?: string;
  level: 'info' | 'ok' | 'warning' | 'critical';
  message: string;
  source?: 'monitor' | 'control';
}

export interface MonitorOptions {
  pollIntervalMs: number;
  requestTimeoutMs: number;
  thresholds: Thresholds;
  /** For tests. */
  rpcFactory?: (d: DirectorConfig) => Rpc;
}

const EVENTS_KEPT = 300;

interface Entry {
  config: DirectorConfig;
  rpc: Rpc;
  cache: ReadCache;
  view: DirectorView;
  reading?: DirectorReading;
  timer?: NodeJS.Timeout;
  busy?: Promise<void>;
  removed?: boolean;
}

export class Monitor extends EventEmitter {
  private entries = new Map<string, Entry>();
  private stopped = true;
  private events: MonitorEvent[] = [];
  private nextEventId = 1;

  constructor(private opts: MonitorOptions) {
    super();
  }

  set thresholds(t: Thresholds) {
    this.opts.thresholds = t;
  }

  /** Makes the polled list match the module's config. Only ever reads. */
  setDirectors(list: DirectorConfig[]): void {
    const wanted = new Map(list.map((d) => [d.id, d]));
    for (const [id, e] of this.entries) {
      const next = wanted.get(id);
      if (!next || next.host !== e.config.host || next.port !== e.config.port) this.drop(e);
      else if (next.label !== e.config.label) {
        e.config = next;
        e.view = { ...e.view, name: nameOf(next, e.reading) };
      }
    }
    let i = 0;
    for (const d of list) {
      if (this.entries.has(d.id)) continue;
      const rpc = this.opts.rpcFactory?.(d) ?? new PixeraClient(d.host, d.port, this.opts.requestTimeoutMs);
      const entry: Entry = { config: d, rpc, cache: newCache(), view: emptyView(d) };
      this.entries.set(d.id, entry);
      if (!this.stopped) entry.timer = setTimeout(() => void this.loop(entry), Math.min(i++ * 150, this.opts.pollIntervalMs));
    }
    this.entries = new Map(list.filter((d) => this.entries.has(d.id)).map((d) => [d.id, this.entries.get(d.id)!]));
    this.emit('change');
  }

  start(): void {
    this.stopped = false;
    let i = 0;
    for (const e of this.entries.values()) if (!e.timer) e.timer = setTimeout(() => void this.loop(e), Math.min(i++ * 150, this.opts.pollIntervalMs));
  }

  stop(): void {
    this.stopped = true;
    for (const e of this.entries.values()) {
      clearTimeout(e.timer);
      e.rpc.close();
    }
    this.removeAllListeners();
  }

  /** Polls every director now (Reconnect). Reads only. */
  pollAll(): void {
    for (const e of this.entries.values()) {
      if (this.stopped) continue;
      clearTimeout(e.timer);
      e.timer = setTimeout(() => void this.loop(e), 0);
    }
  }

  views(): DirectorView[] {
    return [...this.entries.values()].map((e) => e.view);
  }

  view(id: string): DirectorView | undefined {
    return this.entries.get(id)?.view;
  }

  recentEvents(n = 100, director?: string): MonitorEvent[] {
    const list = director ? this.events.filter((e) => e.director === director) : this.events;
    return list.slice(-n).reverse();
  }

  addEvent(e: Omit<MonitorEvent, 'id' | 'time'>): MonitorEvent {
    const ev: MonitorEvent = { id: this.nextEventId++, time: Date.now(), ...e };
    this.events.push(ev);
    if (this.events.length > EVENTS_KEPT) this.events.splice(0, this.events.length - EVENTS_KEPT);
    this.emit('event', ev);
    return ev;
  }

  async pollOnce(id: string): Promise<DirectorView> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`No director "${id}"`);
    await this.poll(e);
    return e.view;
  }

  /**
   * Sends one confirmed command to a director, records it, then reads the director again so every screen shows
   * what Pixera now says. The caller has checked Allow controls and the confirmation.
   */
  async control(id: string, req: ControlRequest, who: string): Promise<DirectorView> {
    const e = this.entries.get(id);
    if (!e) throw new ControlError('That director is not in the list.');
    if (!e.view.reachable || !e.reading) throw new ControlError(`${e.view.name} is not answering.`);
    const what = describe(req, e.reading, e.view.name);
    try {
      await send(e.rpc, e.reading, req);
    } catch (err) {
      if (err instanceof ControlError) throw err;
      const msg = (err as Error).message;
      this.addEvent({ director: id, level: 'warning', source: 'control', message: `${e.view.name}: ${what} failed (${msg}), from ${who}` });
      throw new ControlError(`${e.view.name} did not take it: ${msg}`);
    }
    this.addEvent({ director: id, level: 'info', source: 'control', message: `${e.view.name}: ${what}, from ${who}` });
    // A poll that started before the command would show the old state: wait for it, then read again.
    if (e.busy) await e.busy.catch(() => {});
    if (!e.removed) await this.poll(e);
    return e.view;
  }

  reading(id: string): DirectorReading | undefined {
    return this.entries.get(id)?.reading;
  }

  private drop(e: Entry): void {
    e.removed = true;
    clearTimeout(e.timer);
    e.rpc.close();
    this.entries.delete(e.config.id);
  }

  private async loop(e: Entry): Promise<void> {
    if (this.stopped || e.removed) return;
    await this.poll(e);
    if (this.stopped || e.removed) return;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => void this.loop(e), this.opts.pollIntervalMs);
  }

  private poll(e: Entry): Promise<void> {
    // One read at a time per director: a control's read-back and the timer share it.
    if (e.busy) return e.busy;
    e.busy = this.read(e).finally(() => (e.busy = undefined));
    return e.busy;
  }

  private async read(e: Entry): Promise<void> {
    const prev = e.view;
    let next: Omit<DirectorView, 'alerts' | 'severity'>;
    try {
      const r = await readDirector(e.rpc, e.config.host, e.cache);
      if (e.removed) return;
      e.reading = r;
      next = { id: e.config.id, host: e.config.host, port: e.config.port, name: nameOf(e.config, r), reachable: true, lastSeen: Date.now(), missedPolls: 0, ...r };
    } catch (err) {
      if (e.removed) return;
      // A fresh connection gets its capabilities and structure read again.
      e.cache = newCache();
      e.reading = undefined;
      const { alerts: _a, severity: _s, ...rest } = prev;
      next = { ...rest, reachable: false, lastError: errorText(err), missedPolls: prev.missedPolls + 1 };
    }
    const { alerts, severity } = evaluate(next, this.opts.thresholds, prev.alerts, Date.now());
    e.view = { ...next, alerts, severity };
    this.logChanges(e.view, prev);
    this.emit('change', e.view);
  }

  private logChanges(now: DirectorView, before: DirectorView): void {
    const n = now.name;
    if (now.reachable && before.lastSeen === undefined) {
      const players = now.systems.filter((s) => s.role === 'player').length;
      this.addEvent({ director: now.id, level: 'info', message: `${n}: connected (API revision ${now.apiRevision ?? '?'}, ${players} player${players === 1 ? '' : 's'})` });
    } else if (now.reachable && !before.reachable && before.missedPolls > 0) {
      this.addEvent({ director: now.id, level: 'ok', message: `${n}: answering again` });
    }
    const was = new Map(before.alerts.map((a) => [a.key, a]));
    const is = new Set(now.alerts.map((a) => a.key));
    for (const a of now.alerts) {
      const old = was.get(a.key);
      if (!old || old.severity !== a.severity) this.addEvent({ director: now.id, level: a.severity, message: a.message });
    }
    for (const a of before.alerts) if (!is.has(a.key)) this.addEvent({ director: now.id, level: 'ok', message: `cleared: ${a.message}` });
    if (now.reachable && before.reachable) {
      const old = new Map(before.timelines.map((t) => [t.handle, t]));
      for (const t of now.timelines) {
        const o = old.get(t.handle);
        if (o && o.transport !== t.transport && t.transport !== 'unknown') this.addEvent({ director: now.id, level: 'info', message: `${n}: timeline "${t.name}" ${t.transport === 'play' ? 'playing' : t.transport === 'pause' ? 'paused' : 'stopped'}` });
      }
      const states = new Map(before.systems.map((s) => [s.key, s.state]));
      for (const s of now.systems) {
        const o = states.get(s.key);
        if (o !== undefined && o !== s.state) this.addEvent({ director: now.id, level: 'info', message: `${s.name}: ${s.state || 'no state'}` });
      }
    }
  }
}

function nameOf(d: DirectorConfig, r?: DirectorReading): string {
  return d.label || r?.projectName || d.host;
}

function emptyView(d: DirectorConfig): DirectorView {
  return { id: d.id, host: d.host, port: d.port, name: nameOf(d), reachable: false, missedPolls: 0, systems: [], timelines: [], alerts: [], severity: 'unknown' };
}

export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') return 'connection refused (is the JSON/TCP API on in Pixera’s Settings > API?)';
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'host unreachable';
    if (code) return code;
    return err.message;
  }
  return String(err);
}

export type { Alert };
