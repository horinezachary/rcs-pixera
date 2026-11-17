// Finds PIXERA machines on the show network and labels them. Started only by the operator, and read-only:
//
// 1. Every address on the unit's /24 networks (or one given) is asked Pixera.Utility.getApiRevision on the
//    API port (1400 unless set). An address that answers runs Pixera with its native API on: a director.
//    It is then asked for its project name and its live systems (names, addresses and the "client" flag of
//    LiveSystem.getStructureJson): the clients are its players.
// 2. Every address is also tried with a bare TCP connect (no data sent) on 27101, Pixera's Engine Manager
//    port, so a player that is in no answering director's project still shows, as a Pixera machine.
import net from 'node:net';
import os from 'node:os';
import { DEFAULT_PORT, PixeraClient } from './pixera/client.js';
import { parseStructure } from './pixera/read.js';

export const ENGINE_PORT = 27101;

export interface Found {
  host: string;
  /** API port that answered, 0 when only the engine port did. */
  port: number;
  role: 'director' | 'player' | 'pixera';
  name: string;
  /** Director: its project. Player: the project of the director it was found through. */
  project: string;
  /** Player: the director it was found through. */
  director: string;
  apiRevision: number | null;
  players: number;
  state: string;
}

export function localSubnets(): string[] {
  const out = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.add(a.address.split('.').slice(0, 3).join('.'));
  }
  return [...out];
}

export function isSubnet(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 3 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Opens and closes a TCP connection: true when something listens. Sends nothing. */
export function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      clearTimeout(t);
      s.destroy();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

interface Director {
  host: string;
  port: number;
  project: string;
  apiRevision: number | null;
  systems: { name: string; ip: string; client: boolean | null; state: string }[];
}

/** Asks one address the read-only questions. Undefined when no Pixera API answers there. */
export async function identify(host: string, port = DEFAULT_PORT, timeoutMs = 800): Promise<Director | undefined> {
  if (!(await tcpOpen(host, port, timeoutMs))) return undefined;
  const c = new PixeraClient(host, port, Math.max(timeoutMs, 1500));
  try {
    const rev = await c.request('Pixera.Utility.getApiRevision');
    const opt = (m: string, p?: Record<string, unknown>) => c.request(m, p).catch(() => undefined);
    const project = await opt('Pixera.Session.getProjectName');
    const handles = await opt('Pixera.LiveSystems.getLiveSystems');
    const systems = await Promise.all(
      (Array.isArray(handles) ? handles : []).slice(0, 32).map(async (handle) => {
        const p = { handle };
        const [name, ip, state, st] = await Promise.all([opt('Pixera.LiveSystems.LiveSystem.getName', p), opt('Pixera.LiveSystems.LiveSystem.getIp', p), opt('Pixera.LiveSystems.LiveSystem.getState', p), opt('Pixera.LiveSystems.LiveSystem.getStructureJson', p)]);
        return { name: String(name ?? ''), ip: String(ip ?? ''), state: String(state ?? ''), client: parseStructure(st).client };
      })
    );
    return { host, port, project: typeof project === 'string' ? project : '', apiRevision: typeof rev === 'number' ? rev : null, systems };
  } catch {
    return undefined;
  } finally {
    c.close();
  }
}

/** Labels what answered: directors, the players their projects name, and other Pixera machines. */
export function label(directors: Director[], engines: string[]): Found[] {
  const out = new Map<string, Found>();
  for (const d of directors) {
    out.set(`${d.host}:${d.port}`, { host: d.host, port: d.port, role: 'director', name: d.project || d.host, project: d.project, director: '', apiRevision: d.apiRevision, players: d.systems.filter((s) => s.client === true || (s.client === null && s.ip && s.ip !== d.host)).length, state: '' });
  }
  for (const d of directors) {
    for (const s of d.systems) {
      const player = s.client === true || (s.client === null && s.ip !== '' && s.ip !== d.host);
      if (!player || !s.ip || directors.some((x) => x.host === s.ip)) continue;
      out.set(s.ip, { host: s.ip, port: 0, role: 'player', name: s.name || s.ip, project: d.project, director: d.host, apiRevision: null, players: 0, state: s.state });
    }
  }
  for (const h of engines) if (!out.has(h) && !directors.some((x) => x.host === h)) out.set(h, { host: h, port: 0, role: 'pixera', name: h, project: '', director: '', apiRevision: null, players: 0, state: '' });
  const order = { director: 0, player: 1, pixera: 2 };
  return [...out.values()].sort((a, b) => order[a.role] - order[b.role] || a.host.localeCompare(b.host, undefined, { numeric: true }));
}

export interface ScanTarget {
  host: string;
  port: number;
  enginePort?: number;
}

/** Scans the given targets (or x.y.z.1 to .254 of each subnet), 64 addresses at a time. */
export async function scan(targets: ScanTarget[], timeoutMs = 800): Promise<Found[]> {
  const directors: Director[] = [];
  const engines: string[] = [];
  for (let i = 0; i < targets.length; i += 64) {
    await Promise.all(
      targets.slice(i, i + 64).map(async (t) => {
        const [d, engine] = await Promise.all([identify(t.host, t.port, timeoutMs), tcpOpen(t.host, t.enginePort ?? ENGINE_PORT, timeoutMs)]);
        if (d) directors.push(d);
        else if (engine) engines.push(t.host);
      })
    );
  }
  return label(directors, engines);
}

export function subnetTargets(subnet: string, port: number): ScanTarget[] {
  return Array.from({ length: 254 }, (_, i) => ({ host: `${subnet}.${i + 1}`, port }));
}
