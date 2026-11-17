// Health rules: turn a director reading into alerts. Alerts keep the time they were first raised.
import type { Alert, DirectorView, Severity, SystemView } from './shared.js';
import { worstSeverity } from './shared.js';

export interface Thresholds {
  /** Warn when a server renders this many percent below its outputs' refresh rate. */
  fpsDropWarnPercent: number;
  gpuTempWarnC: number;
  gpuTempCritC: number;
  /** Missed polls before an unreachable director is critical (before that: warning). */
  unreachableAfterPolls: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { fpsDropWarnPercent: 5, gpuTempWarnC: 80, gpuTempCritC: 90, unreachableAfterPolls: 3 };
export const THRESHOLD_RANGES: Record<keyof Thresholds, [number, number]> = {
  fpsDropWarnPercent: [1, 50],
  gpuTempWarnC: [40, 110],
  gpuTempCritC: [40, 120],
  unreachableAfterPolls: [1, 20]
};

export function cleanThresholds(t: unknown): Thresholds {
  const given = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(THRESHOLD_RANGES) as (keyof Thresholds)[]) {
    const v = given[k];
    const [lo, hi] = THRESHOLD_RANGES[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

/** Pixera live system states that mean the engine is up and rendering. */
const RUNNING = /^(engine opened|known|mu project source|mu project receiver)$/i;
/** States on the way up or down: a warning, not yet a fault. */
const MOVING = /^(new|requested info|engine opening|engine closing|engine closing for restart|engine closed for restart|taking over)$/i;
/** States that mean the server is gone or failed. */
const FAILED = /^(lost|engine open failed)$/i;

export function systemAlerts(s: SystemView, t: Thresholds): Omit<Alert, 'since'>[] {
  const out: Omit<Alert, 'since'>[] = [];
  const add = (rule: string, severity: 'warning' | 'critical', message: string, sub = '') => out.push({ key: `${s.key}:${rule}${sub}`, rule, severity, message: `${s.name}: ${message}`, system: s.key });
  const state = s.state.trim();
  if (state && FAILED.test(state)) add('state', 'critical', state === 'Lost' || /lost/i.test(state) ? 'lost (no answer from the server)' : `engine failed to open`);
  else if (state && /^engine closed$/i.test(state)) add('state', 'critical', 'engine closed');
  else if (state && MOVING.test(state)) add('state', 'warning', state.toLowerCase());
  else if (state && !RUNNING.test(state) && !/^(none|undefined)$/i.test(state)) add('state', 'warning', `state "${state}"`);
  if (s.connected === false && !(state && FAILED.test(state))) add('connected', 'critical', 'not connected to the director');

  const running = !state || RUNNING.test(state);
  if (running) {
    for (const o of s.outputs) {
      if (o.enabled && !o.active) add('output', 'warning', `${o.name} is enabled but not active`, `:${o.key}`);
    }
    const rate = Math.max(0, ...s.outputs.filter((o) => o.enabled && o.active && o.fps).map((o) => o.fps!));
    if (s.renderFps !== null && rate > 0 && s.renderFps < rate * (1 - t.fpsDropWarnPercent / 100)) {
      add('fps', 'warning', `rendering ${Math.round(s.renderFps * 10) / 10} fps, outputs run at ${rate}`);
    }
  }
  if (s.gpuTemp !== null) {
    if (s.gpuTemp >= t.gpuTempCritC) add('gpuTemp', 'critical', `GPU at ${s.gpuTemp} °C`);
    else if (s.gpuTemp >= t.gpuTempWarnC) add('gpuTemp', 'warning', `GPU at ${s.gpuTemp} °C`);
  }
  // One alert when the whole server is blacked out, else one per output.
  const blackable = s.outputs.filter((o) => o.blackout !== 'none');
  if (blackable.length > 1 && blackable.every((o) => o.blackout === 'on')) add('blackout', 'warning', `every output blacked out (${blackable.length})`);
  else for (const o of blackable) if (o.blackout === 'on' || o.blackout === 'partial') add('blackout', 'warning', `${o.name} blacked out${o.blackout === 'partial' ? ' (partly)' : ''}`, `:${o.key}`);
  return out;
}

export function evaluate(v: Omit<DirectorView, 'alerts' | 'severity'>, t: Thresholds, previous: Alert[], now: number): { alerts: Alert[]; severity: Severity } {
  const raw: Omit<Alert, 'since'>[] = [];
  if (!v.reachable) {
    if (v.missedPolls > 0) raw.push({ key: 'reach', rule: 'reach', severity: v.missedPolls >= t.unreachableAfterPolls ? 'critical' : 'warning', message: `${v.name}: director not answering${v.lastError ? ` (${v.lastError})` : ''}` });
  } else {
    for (const s of v.systems) raw.push(...systemAlerts(s, t));
    if (v.testPattern) raw.push({ key: 'testPattern', rule: 'testPattern', severity: 'warning', message: `${v.name}: test pattern is on` });
    for (const s of v.systems) for (const o of s.outputs) if (o.identify) raw.push({ key: `${s.key}:identify:${o.key}`, rule: 'identify', severity: 'warning', message: `${s.name}: identify is on for ${o.name}`, system: s.key });
  }
  const was = new Map(previous.map((a) => [a.key, a]));
  const alerts = raw.map((a) => {
    const old = was.get(a.key);
    return { ...a, since: old && old.severity === a.severity ? old.since : now };
  });
  const severity: Severity = !v.reachable && !v.lastSeen ? 'unknown' : alerts.length ? worstSeverity(alerts.map((a) => a.severity)) : 'ok';
  return { alerts, severity };
}

/** Severity of one server, for keys and cards. */
export function systemSeverity(alerts: Alert[], key: string): Severity {
  const mine = alerts.filter((a) => a.system === key);
  return mine.length ? worstSeverity(mine.map((a) => a.severity)) : 'ok';
}
