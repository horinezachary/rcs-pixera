// Reads one PIXERA director over its native API. Every call here is a get: nothing changes on Pixera.
//
// Pixera's API is large and changes between builds, so only the first two calls must answer
// (Pixera.Utility.getApiRevision and Pixera.LiveSystems.getLiveSystems); everything else is optional and
// leaves its field empty when a build does not have it. Which controls a director takes is asked once
// per connection with Pixera.Utility.getHasFunction, also a read.
//
// The output structure (LiveSystem.getStructureJson) and the projectors and screens on each output change
// only when someone edits the project, and Pixera's documentation asks not to call it at short
// intervals, so it is read every 15 s; states, performance, blackout and timelines every poll.
import type { Rpc } from './client.js';
import type { Capabilities, DirectorReading, OutputTarget, OutputView, PerfValue, Role, SystemView, TimelineView, Transport } from '../shared.js';

/** Development and tests can read the structure more often (RCS_PIXERA_STRUCTURE_MS). */
export const structureMs = (): number => Number(process.env.RCS_PIXERA_STRUCTURE_MS) || 15_000;
export const LICENSE_MS = 60_000;
const MAX_TIMELINES = 48;

export const CAP_METHODS: Record<keyof Capabilities, string> = {
  testPattern: 'Pixera.Ui.setDisplayTestpattern',
  identify: 'Pixera.LiveSystems.Output.setIdentify',
  projectorBlackout: 'Pixera.Projectors.Projector.setBlackout',
  screenBlackout: 'Pixera.Screens.Screen.setBlackout',
  restartEngine: 'Pixera.LiveSystems.LiveSystem.restartEngine',
  restartLiveSystem: 'Pixera.Session.restartLiveSystem'
};

interface StructureOutput {
  device: string;
  deviceId: string;
  name: string;
  idPath: string;
  enabled: boolean;
  active: boolean;
  fps: number | null;
  width: number | null;
  height: number | null;
}

interface CachedSystem {
  at: number;
  mac: string;
  client: boolean | null;
  connected: boolean | null;
  outputs: StructureOutput[];
  /** Output handle by structure index, and what is assigned to it. */
  handles: (number | null)[];
  targets: Omit<OutputTarget, 'blackout'>[][];
}

/** What a poller keeps between polls of one director. Cleared when the connection drops. */
export interface ReadCache {
  caps?: Capabilities;
  license?: { at: number; values: PerfValue[]; version: string };
  systems: Map<number, CachedSystem>;
}

export const newCache = (): ReadCache => ({ systems: new Map() });

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

function parseJson(v: unknown): any {
  if (typeof v !== 'string') return v && typeof v === 'object' ? v : null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** Flattens Pixera's JSON values into label/value rows: "system.gpu.temperature" = 61. Keys are not documented. */
export function flatten(obj: unknown, prefix = '', out: PerfValue[] = [], depth = 0): PerfValue[] {
  if (out.length >= 80 || depth > 5) return out;
  if (Array.isArray(obj)) {
    obj.slice(0, 16).forEach((v, i) => {
      const name = v && typeof v === 'object' && typeof (v as any).name === 'string' ? (v as any).name : String(i + 1);
      flatten(v, prefix ? `${prefix}.${name}` : name, out, depth + 1);
    });
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'name' && prefix) continue;
      flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  } else if (typeof obj === 'number' || typeof obj === 'string' || typeof obj === 'boolean') {
    if (prefix) out.push({ label: prefix, value: typeof obj === 'boolean' ? (obj ? 'yes' : 'no') : typeof obj === 'number' ? Math.round(obj * 100) / 100 : obj.slice(0, 80) });
  }
  return out;
}

/** The first numeric value whose label matches. */
export function pick(values: PerfValue[], re: RegExp): number | null {
  for (const v of values) if (re.test(v.label) && typeof v.value === 'number') return v.value;
  return null;
}

export function parseStructure(raw: unknown): Pick<CachedSystem, 'client' | 'connected' | 'outputs'> & { mac?: string } {
  const s = parseJson(raw) ?? {};
  const outputs: StructureOutput[] = [];
  for (const gd of Array.isArray(s.graphicsDevices) ? s.graphicsDevices : []) {
    for (const o of Array.isArray(gd?.outputs) ? gd.outputs : []) {
      const res = Array.isArray(o?.resolution) ? o.resolution : [];
      outputs.push({
        device: str(gd.name) || `Graphics device ${str(gd.idPath || gd.id)}`,
        deviceId: str(gd.idPath ?? gd.id),
        name: str(o.name) || `Output ${str(o.idPath ?? o.id)}`,
        idPath: str(o.idPath ?? o.id),
        enabled: o.enabled !== false,
        active: o.active === true,
        fps: num(o.fps),
        width: num(res[0]),
        height: num(res[1])
      });
    }
  }
  return { client: typeof s.client === 'boolean' ? s.client : null, connected: typeof s.isConnected === 'boolean' ? s.isConnected : null, outputs };
}

export function transportOf(mode: unknown): Transport {
  const n = num(mode);
  return n === 1 ? 'play' : n === 2 ? 'pause' : n === 3 ? 'stop' : 'unknown';
}

function hmsf(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(num(x) ?? 0).padStart(2, '0')).join(':');
  if (typeof v === 'string') return v;
  const n = num(v);
  if (n === null) return '';
  const s = Math.max(0, Math.floor(n));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':');
}

export async function readDirector(rpc: Rpc, host: string, cache: ReadCache, now = Date.now()): Promise<DirectorReading> {
  const opt = async <T>(method: string, params?: Record<string, unknown>): Promise<T | undefined> => {
    try {
      return await rpc.request<T>(method, params);
    } catch {
      return undefined;
    }
  };

  const apiRevision = num(await rpc.request('Pixera.Utility.getApiRevision'));
  const handles = await rpc.request<unknown>('Pixera.LiveSystems.getLiveSystems');

  if (!cache.caps) {
    const entries = await Promise.all(
      (Object.entries(CAP_METHODS) as [keyof Capabilities, string][]).map(async ([k, m]) => [k, (await opt<boolean>('Pixera.Utility.getHasFunction', { functionName: m })) === true] as const)
    );
    cache.caps = Object.fromEntries(entries) as unknown as Capabilities;
  }
  const caps = cache.caps;

  if (!cache.license || now - cache.license.at >= LICENSE_MS) {
    const values = flatten(parseJson(await opt('Pixera.Utility.getLicenseJson')) ?? {});
    const v = values.find((x) => /version|build/i.test(x.label));
    cache.license = { at: now, values: values.slice(0, 24), version: v ? String(v.value) : '' };
  }

  const [projectName, testPattern] = await Promise.all([opt<string>('Pixera.Session.getProjectName'), caps.testPattern ? opt<boolean>('Pixera.Ui.getDisplayTestpattern') : Promise.resolve(undefined)]);

  const list = (Array.isArray(handles) ? handles : []).map(num).filter((h): h is number => h !== null).slice(0, 32);
  for (const h of cache.systems.keys()) if (!list.includes(h)) cache.systems.delete(h);
  const systems = await Promise.all(list.map((h) => readSystem(h)));

  const tl = await opt<unknown>('Pixera.Timelines.getTimelines');
  const tlHandles = (Array.isArray(tl) ? tl : []).map(num).filter((h): h is number => h !== null).slice(0, MAX_TIMELINES);
  const timelines: TimelineView[] = await Promise.all(
    tlHandles.map(async (handle) => {
      const p = { handle };
      const [name, mode, time, fps, opacity] = await Promise.all([
        opt('Pixera.Timelines.Timeline.getName', p),
        opt('Pixera.Timelines.Timeline.getTransportMode', p),
        opt('Pixera.Timelines.Timeline.getCurrentHMSF', p),
        opt('Pixera.Timelines.Timeline.getFps', p),
        opt('Pixera.Timelines.Timeline.getOpacity', p)
      ]);
      return { handle, name: str(name) || `Timeline ${handle}`, transport: transportOf(mode), time: hmsf(time), fps: num(fps), opacity: num(opacity) };
    })
  );

  return {
    apiRevision,
    beta: apiRevision !== null && apiRevision % 2 === 1,
    version: cache.license.version,
    projectName: str(projectName),
    license: cache.license.values,
    testPattern: typeof testPattern === 'boolean' ? testPattern : null,
    systems,
    timelines,
    caps
  };

  async function readSystem(handle: number): Promise<SystemView> {
    const p = { handle };
    const [name, ip, state] = await Promise.all([opt('Pixera.LiveSystems.LiveSystem.getName', p), opt('Pixera.LiveSystems.LiveSystem.getIp', p), opt('Pixera.LiveSystems.LiveSystem.getState', p)]);

    let c = cache.systems.get(handle);
    if (!c || now - c.at >= structureMs()) {
      const [structure, mac, outs] = await Promise.all([
        opt('Pixera.LiveSystems.LiveSystem.getStructureJson', p),
        opt('Pixera.LiveSystems.LiveSystem.getMacAddress', p),
        opt<unknown>('Pixera.LiveSystems.LiveSystem.getAllOutputs', p)
      ]);
      const st = parseStructure(structure);
      // Match the output handles to the structure by name, in order: the structure has no handles.
      const outHandles = (Array.isArray(outs) ? outs : []).map(num).filter((x): x is number => x !== null).slice(0, 32);
      const named = await Promise.all(outHandles.map(async (oh) => ({ handle: oh, name: str(await opt('Pixera.LiveSystems.Output.getName', { handle: oh })) })));
      const used = new Set<number>();
      const handlesByIndex = st.outputs.map((o) => {
        const m = named.find((n) => !used.has(n.handle) && n.name === o.name);
        if (!m) return null;
        used.add(m.handle);
        return m.handle;
      });
      // An output Pixera has a handle for but the structure does not list (older builds): show it by name.
      for (const n of named) {
        if (used.has(n.handle)) continue;
        st.outputs.push({ device: '', deviceId: '', name: n.name || `Output ${n.handle}`, idPath: `h${n.handle}`, enabled: true, active: false, fps: null, width: null, height: null });
        handlesByIndex.push(n.handle);
      }
      const targets = await Promise.all(handlesByIndex.map((oh) => (oh === null ? Promise.resolve([]) : readTargets(oh))));
      c = { at: now, mac: str(mac), client: st.client, connected: st.connected, outputs: st.outputs, handles: handlesByIndex, targets };
      cache.systems.set(handle, c);
    }

    const sysIp = str(ip);
    const sysName = str(name) || sysIp || `Live system ${handle}`;
    const key = sysIp || sysName;
    const outputs: OutputView[] = await Promise.all(
      c.outputs.map(async (o, i) => {
        const oh = c!.handles[i] ?? null;
        const identify = oh !== null && caps.identify ? await opt('Pixera.LiveSystems.Output.getIdentify', { handle: oh }) : undefined;
        const targets: OutputTarget[] = await Promise.all(
          (c!.targets[i] ?? []).map(async (t) => {
            const b = await opt(t.kind === 'projector' ? 'Pixera.Projectors.Projector.getBlackout' : 'Pixera.Screens.Screen.getBlackout', { handle: t.handle });
            return { ...t, blackout: typeof b === 'boolean' ? b : null };
          })
        );
        const on = targets.filter((t) => t.blackout === true).length;
        return {
          key: `${key}/${o.deviceId}/${o.idPath}`,
          handle: oh,
          device: o.device,
          name: o.name,
          enabled: o.enabled,
          active: o.active,
          width: o.width,
          height: o.height,
          fps: o.fps,
          identify: typeof identify === 'boolean' ? identify : null,
          targets,
          blackout: !targets.length ? 'none' : on === targets.length ? 'on' : on ? 'partial' : 'off'
        };
      })
    );

    const raw = (await opt('Pixera.LiveSystems.LiveSystem.getPerformanceMonitoringValuesJsonEx', { handle, filter: 'system,outputsTotal' })) ?? (await opt('Pixera.LiveSystems.LiveSystem.getPerformanceMonitoringValuesJson', p));
    const perf = flatten(parseJson(raw) ?? {});
    // The structure's "client" flag tells a player from the director's own system; without it, the system at
    // the director's address is the director.
    const role: Role = c.client === true ? 'player' : c.client === false ? 'director' : sysIp === host || /^local$/i.test(sysName) ? 'director' : 'player';
    return {
      key,
      handle,
      name: sysName,
      ip: sysIp,
      mac: c.mac,
      state: str(state),
      role,
      connected: c.connected,
      outputs,
      perf,
      renderFps: pick(perf, /(^|\.)(fps|framerate|frameRate|renderFps)$/i) ?? pick(perf, /fps/i),
      gpuTemp: pick(perf, /gpu.*temp|temp.*gpu/i),
      cpuLoad: pick(perf, /cpu.*(usage|load|percent)/i),
      gpuLoad: pick(perf, /gpu.*(usage|load|percent)/i)
    };
  }

  async function readTargets(output: number): Promise<Omit<OutputTarget, 'blackout'>[]> {
    const [projectors, screens] = await Promise.all([
      caps.projectorBlackout ? opt<unknown>('Pixera.LiveSystems.Output.getAssignedProjectors', { handle: output }) : Promise.resolve(undefined),
      caps.screenBlackout ? opt<unknown>('Pixera.LiveSystems.Output.getAssignedScreens', { handle: output }) : Promise.resolve(undefined)
    ]);
    const out: Omit<OutputTarget, 'blackout'>[] = [];
    for (const [kind, list] of [['projector', projectors], ['screen', screens]] as const) {
      for (const h of (Array.isArray(list) ? list : []).map(num).filter((x): x is number => x !== null).slice(0, 16)) {
        const n = await opt(kind === 'projector' ? 'Pixera.Projectors.Projector.getName' : 'Pixera.Screens.Screen.getName', { handle: h });
        out.push({ kind, handle: h, name: str(n) || `${kind === 'projector' ? 'Projector' : 'Screen'} ${h}` });
      }
    }
    return out;
  }
}
