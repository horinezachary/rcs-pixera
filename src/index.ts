// PIXERA Monitor: finds AV Stumpfl PIXERA directors and players on the show network and labels them, and
// watches each director's project over Pixera's native JSON/TCP API: every server (live system) with its
// state, performance values and outputs (resolution, refresh rate, active, identify, blackout), the
// timelines and their transport, the API revision and the licence. The Stream Deck holds output
// blackout and identify, the test pattern, server blackout, a player engine restart and blackout of
// everything.
//
// PIXERA is the source of truth. Everything read is kept only in memory: state holds which server and
// output the panel shows, config holds the director list, the alert limits, the API port to scan and the
// Allow controls switch. Starting, restoring a save, resuming after a power cut and reconnecting only
// read. A command goes out only when the operator asks, only with Allow controls on (off by default), and
// only after a confirmation: a second press of the same key within 3 seconds, or a dialog in the web view.
//
// Pixera's API takes no login (access is limited by Pixera's own IP allowlist), so the module holds no
// secrets.
//
// Stream Deck:
//   keys 1-4   servers of every director (key 4 pages when there are more than 4); press to select
//   key 5      alerts: the count, press for the Alerts view
//   keys 6-9   outputs of the selected server (key 9 pages when there are more than 4); press to select
//   key 10     blackout the selected output on / off
//   key 11     identify the selected output on / off
//   key 12     test pattern on / off (every output of the selected server's director)
//   key 13     blackout every output of the selected server on / off
//   key 14     restart the PIXERA engine on the selected player
//   key 15     blackout every output of every server on / off
//
// On a larger deck (controller 0.21.0+) the top row holds more servers with Alerts on its last key, the
// rows between hold more outputs with output blackout at the end of the second row, and the bottom row
// starts with identify, test pattern, server blackout and restart and ends with blackout all.
//   Every command key needs a second press within 3 s.

import { randomBytes } from 'node:crypto';
import { defineModule, type Ctx, type KeySetParams } from '@rcs/module-sdk';
import { DEFAULT_PORT } from './pixera/client.js';
import { check, describe } from './pixera/control.js';
import { ControlError, Monitor, type DirectorConfig, type MonitorEvent } from './monitor.js';
import { cleanThresholds, DEFAULT_THRESHOLDS, systemSeverity, THRESHOLD_RANGES, type Thresholds } from './rules.js';
import { isSubnet, localSubnets, scan, subnetTargets, type Found, type ScanTarget } from './scan.js';
import { worstSeverity, type ControlRequest, type DirectorView, type OutputView, type Severity, type SystemView } from './shared.js';

export interface State {
  /** The server the panel and keys work on: director id and the server's key in that director. */
  director: string;
  system: string;
  /** The output the output keys work on. */
  output: string;
}

export interface DirectorEntry {
  id: string;
  host: string;
  port: number;
  /** Shown instead of the project name. Empty: the project name. */
  label: string;
}

export interface Config {
  directors: DirectorEntry[];
  thresholds: Thresholds;
  /** The API port Scan asks (Pixera's Settings > API, JSON/TCP). */
  scanPort: number;
  /** Lets the operator send commands. Off: the module only reads. */
  allowControls: boolean;
}

type C = Ctx<State, Config>;
export type View = 'overview' | 'outputs' | 'timelines' | 'alerts' | 'setup';
const VIEWS: View[] = ['overview', 'outputs', 'timelines', 'alerts', 'setup'];

export const KEY = { SYS: [0, 1, 2, 3], ALERTS: 4, OUT: [5, 6, 7, 8], OUT_BLACKOUT: 9, IDENTIFY: 10, TEST: 11, SYS_BLACKOUT: 12, RESTART: 13, ALL_BLACKOUT: 14 } as const;

export interface Grid {
  columns: number;
  rows: number;
}

/** The deck as the controller describes it. Older controllers send no size: 5 × 3. */
export function grid(ctx: { host: { deck: { columns?: number; rows?: number } } }): Grid {
  return { columns: ctx.host.deck.columns ?? 5, rows: ctx.host.deck.rows ?? 3 };
}

export interface Layout {
  keys: number;
  /** Server keys; the last pages when there are more servers than keys. */
  sys: number[];
  alerts: number;
  /** Output keys; the last pages when there are more outputs than keys. */
  out: number[];
  outBlackout: number;
  identify: number;
  test: number;
  sysBlackout: number;
  restart: number;
  allBlackout: number;
}

/** Where everything goes on a deck of this size. On 5 × 3 it is KEY. */
export function layout(g: Grid): Layout {
  const C = g.columns;
  const keys = C * g.rows;
  const bottom = keys - C;
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
  return {
    keys,
    sys: range(0, C - 1),
    alerts: C - 1,
    out: [...range(C, 2 * C - 1), ...range(2 * C, bottom)],
    outBlackout: 2 * C - 1,
    identify: bottom,
    test: bottom + 1,
    sysBlackout: bottom + 2,
    restart: bottom + 3,
    allBlackout: keys - 1
  };
}
export const MAX_DIRECTORS = 8;
export const CONFIRM_MS = 3000;
const pollMs = () => Number(process.env.RCS_PIXERA_POLL_MS) || 3000;
const timeoutMs = () => Number(process.env.RCS_PIXERA_TIMEOUT_MS) || 3000;

const ACCENT = '#F5A524';
const ON_ACCENT = '#16181C';
const CRIT = '#7A2620';
const WARN = '#5A400E';
const ARMED = '#3A2A0E';
const RED = '#FF6B5E';
const TEAL = '#2EC4B6';

interface Armed {
  key: number;
  director: string;
  req: ControlRequest;
  what: string;
  timer: NodeJS.Timeout;
}

interface Runtime {
  monitor: Monitor;
  view: View;
  sysPage: number;
  outPage: number;
  armed: Armed | null;
  scanning: boolean;
  found: Found[];
  drawTimer: NodeJS.Timeout | null;
}
let rt: Runtime | null = null;

/** Config edits run one after another, so two quick adds from a UI never overwrite each other. */
let configChain: Promise<unknown> = Promise.resolve();
function serial(fn: () => Promise<void>): Promise<void> {
  const next = configChain.then(fn, fn);
  configChain = next.catch(() => {});
  return next;
}

const ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:]+\]?$/;
export const validAddress = (a: unknown): a is string => typeof a === 'string' && a !== '' && ADDRESS_RE.test(a);
const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535;

function cleanEntry(d: any): DirectorEntry | null {
  if (!d || typeof d.id !== 'string' || !validAddress(d.host)) return null;
  return { id: d.id, host: d.host, port: validPort(d.port) ? d.port : DEFAULT_PORT, label: typeof d.label === 'string' ? d.label.slice(0, 40) : '' };
}

export function cfg(ctx: C): Config {
  const c = (ctx.config ?? {}) as Partial<Config>;
  return {
    directors: Array.isArray(c.directors) ? c.directors.map(cleanEntry).filter((d): d is DirectorEntry => !!d).slice(0, MAX_DIRECTORS) : [],
    thresholds: cleanThresholds(c.thresholds),
    scanPort: validPort(c.scanPort) ? c.scanPort : DEFAULT_PORT,
    allowControls: c.allowControls ?? false
  };
}

const toMonitor = (e: DirectorEntry): DirectorConfig => ({ id: e.id, host: e.host, port: e.port, ...(e.label ? { label: e.label } : {}) });
const short = (s: string | undefined, n: number): string => [...(s ?? '')].slice(0, n).join('');
const quiet = (p: Promise<unknown>): void => void p.catch(() => {});
const directors = (): DirectorView[] => rt?.monitor.views() ?? [];

interface Server {
  director: DirectorView;
  system: SystemView;
  severity: Severity;
}

/** Every server of every director, in config order: the director's own system first, then its players. */
function servers(): Server[] {
  return directors().flatMap((d) =>
    [...d.systems]
      .sort((a, b) => (a.role === b.role ? 0 : a.role === 'director' ? -1 : 1))
      .map((s) => ({ director: d, system: s, severity: d.reachable ? systemSeverity(d.alerts, s.key) : d.severity }))
  );
}

function currentServer(ctx: C): Server | undefined {
  const list = servers();
  const st = ctx.state.value;
  return list.find((s) => s.director.id === st.director && s.system.key === st.system) ?? list.find((s) => s.system.role === 'player') ?? list[0];
}

function currentOutput(ctx: C, srv = currentServer(ctx)): OutputView | undefined {
  if (!srv) return undefined;
  return srv.system.outputs.find((o) => o.key === ctx.state.value.output) ?? srv.system.outputs[0];
}

function overall(list: DirectorView[]): Severity {
  if (!list.length) return 'unknown';
  const known = list.filter((d) => d.severity !== 'unknown').map((d) => d.severity);
  return known.length ? worstSeverity(known) : 'unknown';
}

function activeAlerts() {
  const rank = (s: string) => (s === 'critical' ? 0 : 1);
  return directors()
    .flatMap((d) => d.alerts.map((a) => ({ ...a, director: d.id, directorName: d.name })))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || b.since - a.since);
}

/** Blackout everywhere: on when every output that can be blacked out is. */
function allBlackout(): 'on' | 'off' | 'partial' | 'none' {
  const outs = directors().flatMap((d) => d.systems.flatMap((s) => s.outputs)).filter((o) => o.blackout !== 'none');
  if (!outs.length) return 'none';
  const on = outs.filter((o) => o.blackout === 'on').length;
  return on === outs.length ? 'on' : on ? 'partial' : 'off';
}

function systemBlackout(s: SystemView): 'on' | 'off' | 'partial' | 'none' {
  const outs = s.outputs.filter((o) => o.blackout !== 'none');
  if (!outs.length) return 'none';
  const on = outs.filter((o) => o.blackout === 'on').length;
  return on === outs.length ? 'on' : on ? 'partial' : 'off';
}

export function snapshot(ctx: C) {
  const c = cfg(ctx);
  const list = directors();
  const srv = currentServer(ctx);
  const out = currentOutput(ctx, srv);
  return {
    type: 'snapshot',
    view: rt?.view ?? 'overview',
    allowControls: c.allowControls,
    thresholds: c.thresholds,
    scanPort: c.scanPort,
    pollSeconds: pollMs() / 1000,
    severity: overall(list),
    directors: list.map((d) => ({
      ...d,
      systems: d.systems.map((s) => ({ ...s, severity: d.reachable ? systemSeverity(d.alerts, s.key) : d.severity, blackout: systemBlackout(s) }))
    })),
    entries: c.directors,
    current: { director: srv?.director.id ?? '', system: srv?.system.key ?? '', output: out?.key ?? '' },
    allBlackout: allBlackout(),
    alerts: activeAlerts(),
    events: rt?.monitor.recentEvents(80) ?? [],
    armed: rt?.armed ? { key: rt.armed.key, what: rt.armed.what } : null,
    scanning: rt?.scanning ?? false,
    found: rt?.found ?? []
  };
}

// ---- keys --------------------------------------------------------------------------------------

function paging(n: number, slots: number): { perPage: number; pages: number } {
  const perPage = n > slots ? slots - 1 : slots;
  return { perPage, pages: Math.max(1, Math.ceil(n / perPage)) };
}

/** The command a key sends now, and the director it goes to ('*' for every director), or null. */
export function commandFor(ctx: C, index: number): { director: string; req: ControlRequest } | null {
  const srv = currentServer(ctx);
  if (!rt) return null;
  const L = layout(grid(ctx));
  if (index === L.allBlackout) {
    const b = allBlackout();
    return b === 'none' ? null : { director: '*', req: { action: 'blackout', scope: 'all', value: b !== 'on' } };
  }
  if (!srv || !srv.director.reachable || !srv.director.caps) return null;
  const d = srv.director;
  const s = srv.system;
  const out = currentOutput(ctx, srv);
  let req: ControlRequest | null = null;
  if (index === L.outBlackout && out && out.blackout !== 'none') req = { action: 'blackout', scope: 'output', system: s.key, output: out.key, value: out.blackout !== 'on' };
  if (index === L.identify && out && out.identify !== null) req = { action: 'identify', scope: 'output', system: s.key, output: out.key, value: !out.identify };
  if (index === L.test && d.testPattern !== null && d.testPattern !== undefined) req = { action: 'testPattern', value: !d.testPattern };
  if (index === L.sysBlackout && systemBlackout(s) !== 'none') req = { action: 'blackout', scope: 'system', system: s.key, value: systemBlackout(s) !== 'on' };
  if (index === L.restart && s.role === 'player') req = { action: 'restart', system: s.key };
  if (!req) return null;
  const r = rt.monitor.reading(d.id);
  try {
    if (!r) return null;
    check(r, req);
  } catch {
    return null;
  }
  return { director: d.id, req };
}

function keyFaces(ctx: C): KeySetParams[] {
  const c = cfg(ctx);
  const list = servers();
  const srv = currentServer(ctx);
  const faces: KeySetParams[] = [];
  const blank = (index: number): KeySetParams => ({ index });

  const L = layout(grid(ctx));
  const { perPage, pages } = paging(list.length, L.sys.length);
  const page = Math.min(rt?.sysPage ?? 0, pages - 1);
  for (const [i, k] of L.sys.entries()) {
    if (i === L.sys.length - 1 && pages > 1) {
      faces.push({ index: k, label: 'MORE ▶', sublabel: `${page + 1} of ${pages}` });
      continue;
    }
    const x = list[page * perPage + i];
    if (!x) {
      faces.push(blank(k));
      continue;
    }
    const sel = srv && x.director.id === srv.director.id && x.system.key === srv.system.key;
    const bg = sel ? ACCENT : x.severity === 'critical' ? CRIT : x.severity === 'warning' ? WARN : undefined;
    const n = x.director.alerts.filter((a) => a.system === x.system.key).length;
    const odd = x.system.state && !/^engine opened$/i.test(x.system.state);
    const sub = !x.director.reachable ? 'OFFLINE' : odd ? short(x.system.state.toUpperCase(), 12) : n ? `${n} ALERT${n === 1 ? '' : 'S'}` : x.system.role === 'director' ? 'DIRECTOR' : 'PLAYER';
    faces.push({ index: k, label: short(x.system.name.toUpperCase(), 10), sublabel: sub, ...(bg ? { background: bg } : {}), ...(sel ? { color: ON_ACCENT } : {}) });
  }
  const n = activeAlerts().length;
  faces.push({ index: L.alerts, label: 'ALERTS', sublabel: n ? `${n} active` : 'none', ...(n ? { background: ACCENT, color: ON_ACCENT } : {}) });

  const armed = rt?.armed?.key ?? -1;
  const allow = c.allowControls;
  const cmd = (index: number, label: string, sublabel: string, on = false, onBg = ACCENT, onColor = ON_ACCENT): KeySetParams => {
    if (!allow) return { index, label, sublabel };
    if (!commandFor(ctx, index)) return { index, label, sublabel: sublabel || '–' };
    if (armed === index) return { index, label, sublabel: 'PRESS AGAIN', background: ARMED, color: '#FFE2B0' };
    return { index, label, sublabel, ...(on ? { background: onBg, color: onColor } : {}) };
  };

  const outs = srv?.system.outputs ?? [];
  const op = paging(outs.length, L.out.length);
  const opage = Math.min(rt?.outPage ?? 0, op.pages - 1);
  const out = currentOutput(ctx, srv);
  L.out.forEach((index, k) => {
    if (k === L.out.length - 1 && op.pages > 1) return faces.push({ index, label: 'OUTPUTS ▶', sublabel: `${opage + 1} of ${op.pages}` });
    const o = outs[opage * op.perPage + k];
    if (!o) return faces.push(blank(index));
    const sel = o.key === out?.key;
    const bad = o.enabled && !o.active;
    const bg = sel ? ACCENT : o.blackout === 'on' ? CRIT : bad ? WARN : undefined;
    faces.push({ index, label: short(o.name.toUpperCase(), 10), sublabel: o.blackout === 'on' ? 'BLACKOUT' : o.identify ? 'IDENTIFY' : bad ? 'NOT ACTIVE' : o.width ? `${o.width}×${o.height}` : '', ...(bg ? { background: bg } : {}), ...(sel ? { color: ON_ACCENT } : {}) });
  });

  if (!srv) {
    for (const k of [L.outBlackout, L.identify, L.test, L.sysBlackout, L.restart]) faces.push(blank(k));
  } else {
    faces.push(out && out.blackout !== 'none' ? cmd(L.outBlackout, 'BLACKOUT', out.blackout === 'on' ? 'OUTPUT ON' : short(out.name.toUpperCase(), 12), out.blackout === 'on', RED, '#141414') : blank(L.outBlackout));
    faces.push(out && out.identify !== null ? cmd(L.identify, 'IDENTIFY', out.identify ? 'ON' : short(out.name.toUpperCase(), 12), !!out.identify, TEAL, '#06201D') : blank(L.identify));
    const tp = srv.director.testPattern;
    faces.push(tp === true || tp === false ? cmd(L.test, 'TEST PTN', tp ? 'ON · ALL' : 'ALL OUTPUTS', tp, TEAL, '#06201D') : blank(L.test));
    const sb = systemBlackout(srv.system);
    faces.push(sb !== 'none' ? cmd(L.sysBlackout, 'SERVER BLK', sb === 'on' ? 'ON' : sb === 'partial' ? 'PARTLY ON' : short(srv.system.name.toUpperCase(), 12), sb === 'on', RED, '#141414') : blank(L.sysBlackout));
    faces.push(srv.system.role === 'player' ? cmd(L.restart, 'RESTART', short(srv.system.name.toUpperCase(), 12)) : blank(L.restart));
  }
  const ab = allBlackout();
  faces.push(ab !== 'none' ? cmd(L.allBlackout, 'BLACKOUT', ab === 'on' ? 'ALL · ON' : ab === 'partial' ? 'ALL · PARTLY' : 'ALL SERVERS', ab === 'on', RED, '#141414') : blank(L.allBlackout));

  if (!allow) {
    const commands = new Set([L.outBlackout, L.identify, L.test, L.sysBlackout, L.restart, L.allBlackout]);
    for (const f of faces) {
      if (!commands.has(f.index) || !f.label) continue;
      if (f.index === L.allBlackout) Object.assign(f, { label: 'VIEW ONLY', sublabel: 'see Setup' });
      delete f.background;
      delete f.color;
    }
  }
  return faces;
}

export async function draw(ctx: C, clientId?: string): Promise<void> {
  const snap = snapshot(ctx);
  if (!clientId) {
    if (rt?.drawTimer) clearTimeout(rt.drawTimer);
    if (rt) rt.drawTimer = null;
    await ctx.keys.setMany(keyFaces(ctx));
  }
  await ctx.ui.send(snap, clientId);
}

function soon(ctx: C): void {
  if (!rt || rt.drawTimer) return;
  rt.drawTimer = setTimeout(() => {
    if (!rt) return;
    rt.drawTimer = null;
    quiet(reportStatus(ctx));
    quiet(draw(ctx));
  }, 120);
}

async function reportStatus(ctx: C): Promise<void> {
  const list = directors();
  if (!list.length) return ctx.status('disconnected', 'Add a PIXERA director in Setup');
  const up = list.filter((d) => d.reachable).length;
  if (up === list.length) {
    const n = activeAlerts().length;
    const players = list.reduce((k, d) => k + d.systems.filter((s) => s.role === 'player').length, 0);
    return ctx.status('connected', n ? `${n} alert${n === 1 ? '' : 's'}` : `${players} player${players === 1 ? '' : 's'}`);
  }
  return ctx.status(up ? 'connecting' : 'disconnected', `${up} of ${list.length} directors answering`);
}

// ---- selection: the module's own state ---------------------------------------------------------

async function setView(ctx: C, v: unknown): Promise<void> {
  if (!rt || !VIEWS.includes(v as View)) return;
  rt.view = v as View;
  quiet(ctx.strip.select(rt.view));
  await draw(ctx);
}

async function selectServer(ctx: C, director: unknown, system: unknown): Promise<void> {
  if (!rt) return;
  const x = servers().find((s) => s.director.id === director && s.system.key === system);
  if (!x) return;
  const st = ctx.state.value;
  if (st.director !== x.director.id || st.system !== x.system.key) {
    disarm();
    rt.outPage = 0;
    await ctx.state.patch({ director: x.director.id, system: x.system.key, output: x.system.outputs[0]?.key ?? '' });
  }
  await draw(ctx);
}

async function selectOutput(ctx: C, key: unknown): Promise<void> {
  const srv = currentServer(ctx);
  if (!rt || !srv || typeof key !== 'string' || !srv.system.outputs.some((o) => o.key === key)) return;
  if (key !== ctx.state.value.output) disarm();
  // Selecting an output also pins its server, so the keys keep acting where the operator looked.
  await ctx.state.patch({ director: srv.director.id, system: srv.system.key, output: key });
  await draw(ctx);
}

// ---- setup: the module's own config, reads only ----------------------------------------------

function syncMonitor(ctx: C): void {
  if (!rt) return;
  const c = cfg(ctx);
  rt.monitor.thresholds = c.thresholds;
  rt.monitor.setDirectors(c.directors.map(toMonitor));
  quiet(reportStatus(ctx));
}

async function addDirector(ctx: C, m: any): Promise<void> {
  if (!rt) return;
  const host = typeof m.host === 'string' ? m.host.trim() : '';
  if (!validAddress(host)) return ctx.notify('That is not an IP address or host name', 'warning');
  const port = m.port === undefined || m.port === '' || m.port === null || m.port === 0 ? cfg(ctx).scanPort : Number(m.port);
  if (!validPort(port)) return ctx.notify('Port must be 1 to 65535', 'warning');
  const c = cfg(ctx);
  if (c.directors.some((d) => d.host === host && d.port === port)) return ctx.notify(`${host}:${port} is already in the list`);
  if (c.directors.length >= MAX_DIRECTORS) return ctx.notify(`Up to ${MAX_DIRECTORS} directors`, 'warning');
  const id = randomBytes(4).toString('hex');
  const label = typeof m.label === 'string' ? m.label.trim().slice(0, 40) : '';
  await ctx.setConfig({ ...c, directors: [...c.directors, { id, host, port, label }] });
  await ctx.log('info', `Added PIXERA director ${host}:${port}`);
  syncMonitor(ctx);
  await draw(ctx);
}

async function editDirector(ctx: C, m: any): Promise<void> {
  const c = cfg(ctx);
  const e = c.directors.find((d) => d.id === m.id);
  if (!e || typeof m.label !== 'string') return;
  await ctx.setConfig({ ...c, directors: c.directors.map((d) => (d.id === e.id ? { ...d, label: m.label.trim().slice(0, 40) } : d)) });
  syncMonitor(ctx);
  await draw(ctx);
}

async function removeDirector(ctx: C, id: unknown): Promise<void> {
  const c = cfg(ctx);
  const e = c.directors.find((d) => d.id === id);
  if (!rt || !e) return;
  await ctx.setConfig({ ...c, directors: c.directors.filter((d) => d.id !== e.id) });
  if (rt.armed && (rt.armed.director === e.id || rt.armed.director === '*')) disarm();
  await ctx.log('info', `Removed PIXERA director ${e.host}:${e.port}`);
  syncMonitor(ctx);
  if (ctx.state.value.director === e.id) await ctx.state.patch({ director: '', system: '', output: '' });
  await draw(ctx);
}

async function moveDirector(ctx: C, id: unknown, by: unknown): Promise<void> {
  const c = cfg(ctx);
  const i = c.directors.findIndex((d) => d.id === id);
  const j = i + (by === -1 ? -1 : 1);
  if (i < 0 || j < 0 || j >= c.directors.length) return;
  const list = [...c.directors];
  [list[i], list[j]] = [list[j]!, list[i]!];
  await ctx.setConfig({ ...c, directors: list });
  syncMonitor(ctx);
  await draw(ctx);
}

async function setThresholds(ctx: C, t: unknown): Promise<void> {
  const c = cfg(ctx);
  const given = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(given)) {
    const range = THRESHOLD_RANGES[k as keyof Thresholds];
    if (!range) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < range[0] || v > range[1]) return ctx.notify(`Not saved: that limit must be from ${range[0]} to ${range[1]}`, 'warning');
  }
  const merged = cleanThresholds({ ...c.thresholds, ...given });
  if (merged.gpuTempCritC < merged.gpuTempWarnC) return ctx.notify('The critical GPU limit must be at or above the warning limit', 'warning');
  await ctx.setConfig({ ...c, thresholds: merged });
  syncMonitor(ctx);
  await ctx.notify('Alert limits saved. They apply from the next poll.');
  await draw(ctx);
}

async function setScanPort(ctx: C, p: unknown): Promise<void> {
  const port = Number(p);
  if (!validPort(port)) return ctx.notify('Port must be 1 to 65535', 'warning');
  await ctx.setConfig({ ...cfg(ctx), scanPort: port });
  await draw(ctx);
}

async function setAllow(ctx: C, on: unknown): Promise<void> {
  await ctx.setConfig({ ...cfg(ctx), allowControls: !!on });
  if (!on) disarm();
  await ctx.log('info', on ? 'Controls allowed' : 'Controls turned off: the module only reads');
  await draw(ctx);
}

/** Test and development hook: comma-separated host:port list to ask instead of scanning the subnets. */
function scanTargets(): ScanTarget[] | null {
  const env = process.env.RCS_PIXERA_SCAN;
  if (!env) return null;
  return env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [host, port, engine] = s.split(':');
      return { host: host!, port: Number(port) || DEFAULT_PORT, ...(engine ? { enginePort: Number(engine) } : {}) };
    });
}

async function runScan(ctx: C, subnet?: unknown): Promise<void> {
  if (!rt || rt.scanning) return;
  const r = rt;
  const port = cfg(ctx).scanPort;
  let targets = scanTargets();
  if (!targets) {
    const subnets = typeof subnet === 'string' && subnet.trim() ? [subnet.trim().replace(/\.$/, '')] : localSubnets();
    if (!subnets.length || subnets.some((s) => !isSubnet(s))) return ctx.notify('Give the first three parts of an address, like 10.10.30', 'warning');
    targets = subnets.flatMap((s) => subnetTargets(s, port));
  }
  r.scanning = true;
  await draw(ctx);
  try {
    const found = await scan(targets);
    if (rt !== r) return;
    r.found = found.slice(0, 96);
    if (!found.length) await ctx.notify(`No PIXERA machine answered (API port ${port}, engine port 27101)`);
  } catch (e) {
    await ctx.notify(`Scan failed: ${(e as Error).message}`, 'warning');
  } finally {
    if (rt === r) {
      r.scanning = false;
      await draw(ctx);
    }
  }
}

// ---- operator actions: the only things that change PIXERA ---------------------------------------

function disarm(): void {
  if (!rt?.armed) return;
  clearTimeout(rt.armed.timer);
  rt.armed = null;
}

function whatFor(director: string, req: ControlRequest): string {
  if (director === '*') return describe(req, undefined, 'every director');
  const d = rt?.monitor.view(director);
  return describe(req, rt?.monitor.reading(director), d?.name);
}

/** Sends a confirmed command. Blackout of everything goes to every director that can take it. */
async function send(ctx: C, director: string, req: ControlRequest, who: string): Promise<boolean> {
  if (!rt) return false;
  if (!cfg(ctx).allowControls) {
    await ctx.notify('This module only reads. Turn on Allow controls in Setup to send commands.', 'warning');
    return false;
  }
  const targets = director === '*' ? directors().filter((d) => d.reachable && d.systems.some((s) => s.outputs.some((o) => o.blackout !== 'none'))) : [rt.monitor.view(director)].filter((d): d is DirectorView => !!d);
  if (!targets.length) {
    await ctx.notify('No director to send that to is answering.', 'warning');
    return false;
  }
  let ok = true;
  for (const d of targets) {
    try {
      await rt.monitor.control(d.id, req, who);
      await ctx.log('info', `${d.name}: ${whatFor(d.id, req)} (${who})`);
    } catch (e) {
      ok = false;
      await ctx.notify(e instanceof ControlError ? e.message : `Not sent: ${(e as Error).message}`, 'error');
    }
  }
  if (ok) await ctx.notify(`Sent: ${whatFor(director, req)}`);
  await draw(ctx);
  return ok;
}

/** First press arms a command key; a second press of the same key within CONFIRM_MS sends it. */
async function pressCommand(ctx: C, index: number): Promise<void> {
  if (!rt) return;
  const c = commandFor(ctx, index);
  if (!c) return;
  if (!cfg(ctx).allowControls) {
    disarm();
    await ctx.notify('This module only reads. Turn on Allow controls in Setup to send commands.', 'warning');
    return;
  }
  const a = rt.armed;
  if (a && a.key === index && a.director === c.director && JSON.stringify(a.req) === JSON.stringify(c.req)) {
    disarm();
    await draw(ctx);
    await send(ctx, c.director, c.req, 'the panel keys');
    return;
  }
  disarm();
  const r = rt;
  r.armed = {
    key: index,
    director: c.director,
    req: c.req,
    what: whatFor(c.director, c.req),
    timer: setTimeout(() => {
      if (rt !== r || r.armed?.key !== index) return;
      r.armed = null;
      quiet(draw(ctx));
    }, CONFIRM_MS)
  };
  await draw(ctx); // the key and the screen say "press again"; nothing is sent yet
}

/** A control request from a UI, checked field by field. */
export function requestOf(m: any): ControlRequest | null {
  const s = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 300;
  const value = !!m?.value;
  switch (m?.action) {
    case 'testPattern':
      return { action: 'testPattern', value };
    case 'restart':
      return s(m.system) ? { action: 'restart', system: m.system } : null;
    case 'identify':
    case 'blackout':
      if (m.scope === 'output' && s(m.system) && s(m.output)) return { action: m.action, scope: 'output', system: m.system, output: m.output, value };
      if (m.scope === 'system' && s(m.system)) return { action: m.action, scope: 'system', system: m.system, value };
      if (m.scope === 'all' && m.action === 'blackout') return { action: 'blackout', scope: 'all', value };
  }
  return null;
}

export default defineModule<State, Config>({
  // Every key of a larger deck: more servers and outputs. Older controllers ignore this and send 15 keys.
  fullDeck: true,

  // The deck changed size: an armed key may have moved and the pages changed.
  async deck(ctx) {
    if (!rt) return;
    disarm();
    rt.sysPage = 0;
    rt.outPage = 0;
    await ctx.keys.clear();
    await draw(ctx);
  },

  async start(ctx) {
    if (rt) rt.monitor.stop();
    const c = cfg(ctx);
    const monitor = new Monitor({ pollIntervalMs: pollMs(), requestTimeoutMs: timeoutMs(), thresholds: c.thresholds ?? DEFAULT_THRESHOLDS });
    const r: Runtime = (rt = { monitor, view: 'overview', sysPage: 0, outPage: 0, armed: null, scanning: false, found: [], drawTimer: null });
    await ctx.state.init({ director: '', system: '', output: '' });
    await ctx.strip.set([
      { id: 'overview', label: 'Servers', icon: 'assets/overview.svg' },
      { id: 'outputs', label: 'Outputs', icon: 'assets/outputs.svg' },
      { id: 'timelines', label: 'Timeline', icon: 'assets/timelines.svg' },
      { id: 'alerts', label: 'Alerts', icon: 'assets/alerts.svg' },
      { id: 'setup', label: 'Setup', icon: 'assets/setup.svg' }
    ]);
    monitor.on('change', () => rt === r && soon(ctx));
    monitor.on('event', (e: MonitorEvent) => {
      if (rt !== r || e.source === 'control') return;
      if (e.level === 'warning' || e.level === 'critical') quiet(ctx.log(e.level === 'critical' ? 'error' : 'warning', e.message));
    });
    monitor.setDirectors(c.directors.map(toMonitor));
    monitor.start(); // reads only: nothing is sent on start, whatever the reason
    await reportStatus(ctx);
    await draw(ctx);
  },

  stop() {
    if (!rt) return;
    if (rt.drawTimer) clearTimeout(rt.drawTimer);
    disarm();
    rt.monitor.stop();
    rt = null;
  },

  async key(ctx, { index, action }) {
    if (action !== 'down' || !rt) return;
    const L = layout(grid(ctx));
    const sys = L.sys.indexOf(index);
    if (sys >= 0) {
      const list = servers();
      const { perPage, pages } = paging(list.length, L.sys.length);
      if (sys === L.sys.length - 1 && pages > 1) {
        rt.sysPage = (rt.sysPage + 1) % pages;
        return draw(ctx);
      }
      const x = list[Math.min(rt.sysPage, pages - 1) * perPage + sys];
      if (x) await selectServer(ctx, x.director.id, x.system.key);
      return;
    }
    if (index === L.alerts) return setView(ctx, 'alerts');
    const out = L.out.indexOf(index);
    if (out >= 0) {
      const outs = currentServer(ctx)?.system.outputs ?? [];
      const { perPage, pages } = paging(outs.length, L.out.length);
      if (out === L.out.length - 1 && pages > 1) {
        rt.outPage = (rt.outPage + 1) % pages;
        return draw(ctx);
      }
      const o = outs[Math.min(rt.outPage, pages - 1) * perPage + out];
      if (o) await selectOutput(ctx, o.key);
      return;
    }
    await pressCommand(ctx, index);
  },

  async strip(ctx, id) {
    await setView(ctx, id);
  },

  async client(ctx, { clientId, action }) {
    if (action === 'connect') await draw(ctx, clientId);
  },

  async ui(ctx, { clientId, message: m }) {
    if (!rt || typeof m !== 'object' || m === null) return;
    switch (m.type) {
      case 'hello':
        return draw(ctx, clientId);
      case 'view':
        return setView(ctx, m.view);
      case 'select':
        return selectServer(ctx, m.director, m.system);
      case 'select-output':
        return selectOutput(ctx, m.output);
      case 'control': {
        // From a screen that already asked the operator to confirm (a dialog).
        const req = requestOf(m.req);
        if (!req || typeof m.director !== 'string') return;
        if (req.action === 'blackout' && req.scope === 'all') m.director = '*';
        await send(ctx, m.director, req, m.from === 'web' ? 'the web view' : 'the panel');
        return;
      }
      case 'add':
        return serial(() => addDirector(ctx, m));
      case 'edit':
        return serial(() => editDirector(ctx, m));
      case 'remove':
        return serial(() => removeDirector(ctx, m.id));
      case 'move':
        return serial(() => moveDirector(ctx, m.id, m.by));
      case 'thresholds':
        return serial(() => setThresholds(ctx, m.values));
      case 'scan-port':
        return serial(() => setScanPort(ctx, m.port));
      case 'allow':
        return serial(() => setAllow(ctx, m.on));
      case 'scan':
        return runScan(ctx, m.subnet);
      case 'reconnect':
        rt.monitor.pollAll();
        return;
    }
  }
});
