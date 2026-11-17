// A simulated PIXERA director for development and tests: its native API over JSON/TCP ("pxr1" framing),
// with the director's own live system, its players, their outputs with projectors and screens, and
// timelines. It answers the methods the module uses and records every call that would change something
// in `writes`. Nothing here talks to real equipment.
//
// Scenarios (set `scenario`, or GET-free: send {"method":"Sim.setScenario","params":{"name":"..."}}):
//   normal           everything up
//   player-lost      the second player is Lost
//   output-inactive  an enabled output of the first player is not active
//   fps-drop         the first player renders 50 fps into 60 Hz outputs
//   gpu-hot          the first player's GPU at 92 °C
//   old-build        an older build: no getHasFunction, no restartEngine, no test pattern
import net from 'node:net';
import { frame, unframe } from '../pixera/client.js';

export type Scenario = 'normal' | 'player-lost' | 'output-inactive' | 'fps-drop' | 'gpu-hot' | 'old-build';

interface SimTarget {
  handle: number;
  name: string;
  blackout: boolean;
}

interface SimOutput {
  handle: number;
  name: string;
  idPath: string;
  fps: number;
  width: number;
  height: number;
  enabled: boolean;
  active: boolean;
  identify: boolean;
  projectors: number[];
  screens: number[];
}

interface SimSystem {
  handle: number;
  name: string;
  ip: string;
  mac: string;
  client: boolean;
  state: string;
  device: string;
  outputs: SimOutput[];
  gpuTemp: number;
  fps: number;
}

interface SimTimeline {
  handle: number;
  name: string;
  mode: 1 | 2 | 3;
  frame: number;
  fps: number;
  opacity: number;
}

export interface SimSystemSpec {
  name: string;
  ip: string;
  client: boolean;
  outputs: { name: string; screen?: string; projector?: string; width?: number; height?: number; fps?: number }[];
}

export interface PixeraSimOptions {
  project?: string;
  apiRevision?: number;
  systems?: SimSystemSpec[];
  timelines?: { name: string; playing?: boolean }[];
  /** How long a player's engine takes to come back after a restart. */
  restartMs?: number;
}

export const DEFAULT_SYSTEMS: SimSystemSpec[] = [
  { name: 'Director', ip: '10.10.30.10', client: false, outputs: [{ name: 'GUI Preview', width: 1920, height: 1080 }] },
  {
    name: 'Player 1',
    ip: '10.10.30.11',
    client: true,
    outputs: [
      { name: 'LED Main L', screen: 'LED Wall Left' },
      { name: 'LED Main R', screen: 'LED Wall Right' },
      { name: 'Proj 1', projector: 'Projector 1' },
      { name: 'Proj 2', projector: 'Projector 2' }
    ]
  },
  {
    name: 'Player 2',
    ip: '10.10.30.12',
    client: true,
    outputs: [
      { name: 'IMAG L', screen: 'IMAG Left' },
      { name: 'IMAG R', screen: 'IMAG Right' }
    ]
  }
];

export class PixeraSimulator {
  scenario: Scenario = 'normal';
  /** Every call that changes something: method and params. */
  writes: { method: string; params: any }[] = [];
  /** Every call, for tests that check what was read. */
  calls: string[] = [];
  project: string;
  apiRevision: number;
  testPattern = false;
  systems: SimSystem[] = [];
  projectors = new Map<number, SimTarget>();
  screens = new Map<number, SimTarget>();
  timelines: SimTimeline[] = [];
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private restartMs: number;
  private ticker: NodeJS.Timeout | null = null;
  private timers = new Set<NodeJS.Timeout>();

  constructor(o: PixeraSimOptions = {}) {
    this.project = o.project ?? 'Main Show';
    this.apiRevision = o.apiRevision ?? 480;
    this.restartMs = o.restartMs ?? 4000;
    let h = 1000;
    for (const s of o.systems ?? DEFAULT_SYSTEMS) {
      const outputs = s.outputs.map((spec, i) => {
        const out: SimOutput = { handle: ++h, name: spec.name, idPath: String(i + 1), fps: spec.fps ?? 60, width: spec.width ?? 3840, height: spec.height ?? 2160, enabled: true, active: true, identify: false, projectors: [], screens: [] };
        if (spec.projector) {
          const ph = ++h;
          this.projectors.set(ph, { handle: ph, name: spec.projector, blackout: false });
          out.projectors.push(ph);
        }
        if (spec.screen) {
          const sh = ++h;
          this.screens.set(sh, { handle: sh, name: spec.screen, blackout: false });
          out.screens.push(sh);
        }
        return out;
      });
      const n = this.systems.length + 1;
      this.systems.push({ handle: ++h, name: s.name, ip: s.ip, mac: `00:1B:21:3A:00:${String(n).padStart(2, '0')}`, client: s.client, state: 'Engine Opened', device: 'NVIDIA RTX A6000', outputs, gpuTemp: 58 + n * 3, fps: 60 });
    }
    const tls = o.timelines ?? [{ name: 'Show', playing: true }, { name: 'Walk-in Loop' }, { name: 'Stinger' }];
    for (const t of tls) this.timelines.push({ handle: ++h, name: t.name, mode: t.playing ? 1 : 3, frame: t.playing ? 60 * 754 : 0, fps: 60, opacity: 1 });
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    this.server = net.createServer((s) => this.serve(s));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    this.ticker = setInterval(() => {
      for (const t of this.timelines) if (t.mode === 1) t.frame += t.fps / 4;
    }, 250);
    return (this.server.address() as net.AddressInfo).port;
  }

  async close(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    for (const t of this.timers) clearTimeout(t);
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private serve(s: net.Socket): void {
    this.sockets.add(s);
    let buf: Buffer = Buffer.alloc(0);
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => s.destroy());
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let out;
      try {
        out = unframe(buf);
      } catch {
        s.destroy();
        return;
      }
      buf = out.rest;
      for (const text of out.messages) {
        let msg: any;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }
        let reply: any;
        try {
          const result = this.call(String(msg.method), msg.params ?? {});
          reply = { jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result };
        } catch (e) {
          reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: (e as Error).message } };
        }
        if (msg.id !== undefined) s.write(frame(reply));
      }
    });
  }

  private sys(h: number): SimSystem {
    const s = this.systems.find((x) => x.handle === h);
    if (!s) throw new Error('invalid handle');
    return { ...s, ...this.scenarioOf(s) };
  }

  private scenarioOf(s: SimSystem): Partial<SimSystem> {
    const players = this.systems.filter((x) => x.client);
    if (this.scenario === 'player-lost' && s === players[1]) return { state: 'Lost' };
    if (this.scenario === 'fps-drop' && s === players[0]) return { fps: 50 };
    if (this.scenario === 'gpu-hot' && s === players[0]) return { gpuTemp: 92 };
    return {};
  }

  private out(h: number): SimOutput {
    for (const s of this.systems) for (const o of s.outputs) if (o.handle === h) return o;
    throw new Error('invalid handle');
  }

  private isActive(o: SimOutput): boolean {
    const p1 = this.systems.filter((x) => x.client)[0];
    if (this.scenario === 'output-inactive' && p1?.outputs[1] === o) return false;
    return o.active;
  }

  private write(method: string, params: any): void {
    this.writes.push({ method, params });
  }

  /** Answers one API call, like Pixera does. Throws for methods it does not know. */
  call(method: string, p: any): unknown {
    this.calls.push(method);
    const old = this.scenario === 'old-build';
    switch (method) {
      case 'Sim.setScenario':
        this.scenario = p.name;
        return true;
      case 'Pixera.Utility.getApiRevision':
        return old ? 322 : this.apiRevision;
      case 'Pixera.Utility.getHasFunction':
        if (old) throw new Error('Method not found');
        return true;
      case 'Pixera.Utility.getLicenseJson':
        return JSON.stringify({ product: 'PIXERA two', version: '26.1 R39', licenseType: 'dongle', outputs: 8 });
      case 'Pixera.Session.getProjectName':
        return this.project;
      case 'Pixera.Ui.getDisplayTestpattern':
        if (old) throw new Error('Method not found');
        return this.testPattern;
      case 'Pixera.Ui.setDisplayTestpattern':
        if (old) throw new Error('Method not found');
        this.write(method, p);
        this.testPattern = !!p.display;
        return null;
      case 'Pixera.LiveSystems.getLiveSystems':
        return this.systems.map((s) => s.handle);
      case 'Pixera.LiveSystems.LiveSystem.getName':
        return this.sys(p.handle).name;
      case 'Pixera.LiveSystems.LiveSystem.getIp':
        return this.sys(p.handle).ip;
      case 'Pixera.LiveSystems.LiveSystem.getMacAddress':
        return this.sys(p.handle).mac;
      case 'Pixera.LiveSystems.LiveSystem.getState':
        return this.sys(p.handle).state;
      case 'Pixera.LiveSystems.LiveSystem.getAllOutputs':
        return this.sys(p.handle).outputs.map((o) => o.handle);
      case 'Pixera.LiveSystems.LiveSystem.getStructureJson': {
        const s = this.sys(p.handle);
        const up = s.state === 'Engine Opened';
        return JSON.stringify({
          name: s.name,
          ip: s.ip,
          state: s.state,
          isConnected: s.state !== 'Lost',
          isInUse: true,
          client: s.client,
          graphicsDevices: [{ id: 1, idPath: '1', name: s.device, type: 'gpu', outputs: s.outputs.map((o) => ({ id: Number(o.idPath), idPath: o.idPath, name: o.name, type: 'display', enabled: o.enabled, active: up && this.isActive(o), fps: o.fps, resolution: [o.width, o.height] })) }],
          videoDevices: []
        });
      }
      case 'Pixera.LiveSystems.LiveSystem.getPerformanceMonitoringValuesJsonEx':
        if (old) throw new Error('Method not found');
      // falls through
      case 'Pixera.LiveSystems.LiveSystem.getPerformanceMonitoringValuesJson': {
        const s = this.sys(p.handle);
        if (s.state !== 'Engine Opened') return JSON.stringify({ system: { cpuUsage: 3 } });
        return JSON.stringify({ system: { fps: s.fps, cpuUsage: 18 + s.handle % 7, gpuUsage: 41 + s.handle % 11, gpuTemperature: s.gpuTemp, ramUsage: 37, droppedFrames: s.fps < 60 ? 312 : 0 }, outputsTotal: { pixels: s.outputs.reduce((n, o) => n + o.width * o.height, 0) } });
      }
      case 'Pixera.LiveSystems.LiveSystem.restartEngine':
        if (old) throw new Error('Method not found');
      // falls through
      case 'Pixera.Session.restartLiveSystem': {
        this.write(method, p);
        const s = method.endsWith('restartEngine') ? this.systems.find((x) => x.handle === p.handle) : this.systems.find((x) => x.ip === p.ip);
        if (!s) throw new Error('invalid handle');
        s.state = 'Engine Closing For Restart';
        const t = setTimeout(() => {
          s.state = 'Engine Opening';
          const t2 = setTimeout(() => {
            s.state = 'Engine Opened';
            this.timers.delete(t2);
          }, this.restartMs / 2);
          this.timers.add(t2);
          this.timers.delete(t);
        }, this.restartMs / 2);
        this.timers.add(t);
        return null;
      }
      case 'Pixera.LiveSystems.Output.getName':
        return this.out(p.handle).name;
      case 'Pixera.LiveSystems.Output.getIdentify':
        return this.out(p.handle).identify;
      case 'Pixera.LiveSystems.Output.setIdentify':
        this.write(method, p);
        this.out(p.handle).identify = !!p.state;
        return null;
      case 'Pixera.LiveSystems.Output.getAssignedProjectors':
        return this.out(p.handle).projectors;
      case 'Pixera.LiveSystems.Output.getAssignedScreens':
        return this.out(p.handle).screens;
      case 'Pixera.Projectors.Projector.getName':
      case 'Pixera.Screens.Screen.getName':
      case 'Pixera.Projectors.Projector.getBlackout':
      case 'Pixera.Screens.Screen.getBlackout':
      case 'Pixera.Projectors.Projector.setBlackout':
      case 'Pixera.Screens.Screen.setBlackout': {
        const t = (method.includes('Projector') ? this.projectors : this.screens).get(p.handle);
        if (!t) throw new Error('invalid handle');
        if (method.endsWith('getName')) return t.name;
        if (method.endsWith('getBlackout')) return t.blackout;
        this.write(method, p);
        t.blackout = !!p.isActive;
        return null;
      }
      case 'Pixera.Timelines.getTimelines':
        return this.timelines.map((t) => t.handle);
    }
    if (method.startsWith('Pixera.Timelines.Timeline.')) {
      const t = this.timelines.find((x) => x.handle === p.handle);
      if (!t) throw new Error('invalid handle');
      switch (method.slice('Pixera.Timelines.Timeline.'.length)) {
        case 'getName':
          return t.name;
        case 'getTransportMode':
          return t.mode;
        case 'getFps':
          return t.fps;
        case 'getOpacity':
          return t.opacity;
        case 'getCurrentHMSF': {
          const f = Math.floor(t.frame);
          const s = Math.floor(f / t.fps);
          return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60, f % t.fps];
        }
      }
    }
    throw new Error(`Method not found: ${method}`);
  }
}
