// The API framing, the tolerant readers and the labelling, without the module.
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { frame, PixeraClient, unframe } from '../src/pixera/client.js';
import { flatten, parseStructure, pick, transportOf } from '../src/pixera/read.js';
import { DEFAULT_THRESHOLDS, systemAlerts } from '../src/rules.js';
import { label, scan } from '../src/scan.js';
import type { SystemView } from '../src/shared.js';
import { PixeraSimulator } from '../src/sim/pixera.js';

describe('framing', () => {
  it('writes "pxr1", the body length little-endian, then the JSON', () => {
    const b = frame({ jsonrpc: '2.0', id: 1, method: 'Pixera.Utility.getApiRevision' });
    expect(b.subarray(0, 4).toString()).toBe('pxr1');
    expect(b.readUInt32LE(4)).toBe(b.length - 8);
    expect(JSON.parse(b.subarray(8).toString())).toMatchObject({ method: 'Pixera.Utility.getApiRevision' });
  });

  it('splits a stream across chunk boundaries and counts UTF-8 bytes', () => {
    const all = Buffer.concat([frame({ a: 'Bühne' }), frame({ b: 2 })]);
    const first = unframe(all.subarray(0, 13));
    expect(first.messages).toEqual([]);
    const rest = unframe(Buffer.concat([first.rest, all.subarray(13)]));
    expect(rest.messages.map((m) => JSON.parse(m))).toEqual([{ a: 'Bühne' }, { b: 2 }]);
  });

  it('rejects requests on an error reply and times out on silence', async () => {
    const sim = new PixeraSimulator();
    const port = await sim.listen();
    const c = new PixeraClient('127.0.0.1', port, 300);
    await expect(c.request('Pixera.Nope')).rejects.toThrow(/Method not found/);
    expect(await c.request('Pixera.Utility.getApiRevision')).toBe(480);
    c.close();
    await sim.close();
    const quiet = net.createServer(() => {});
    await new Promise<void>((r) => quiet.listen(0, '127.0.0.1', r));
    const q = new PixeraClient('127.0.0.1', (quiet.address() as net.AddressInfo).port, 200);
    await expect(q.request('Pixera.Utility.getApiRevision')).rejects.toThrow(/no answer/);
    q.close();
    quiet.close();
  });
});

describe('reading', () => {
  it('flattens performance values whatever their shape', () => {
    const v = flatten({ system: { fps: 59.94, gpu: [{ name: 'RTX A6000', temperature: 71 }] }, ok: true });
    expect(v).toEqual([
      { label: 'system.fps', value: 59.94 },
      { label: 'system.gpu.RTX A6000.temperature', value: 71 },
      { label: 'ok', value: 'yes' }
    ]);
    expect(pick(v, /gpu.*temp/i)).toBe(71);
  });

  it('reads the output structure', () => {
    const s = parseStructure(JSON.stringify({ client: true, isConnected: true, graphicsDevices: [{ idPath: '1', name: 'GPU', outputs: [{ idPath: '2', name: 'Out 2', enabled: true, active: false, fps: 50, resolution: [1920, 1080] }] }] }));
    expect(s).toEqual({ client: true, connected: true, outputs: [{ device: 'GPU', deviceId: '1', name: 'Out 2', idPath: '2', enabled: true, active: false, fps: 50, width: 1920, height: 1080 }] });
    expect(parseStructure('not json').outputs).toEqual([]);
  });

  it('maps transport modes', () => {
    expect([1, 2, 3, 7, '1'].map(transportOf)).toEqual(['play', 'pause', 'stop', 'unknown', 'play']);
  });
});

describe('rules', () => {
  const sys = (state: string, extra: Partial<SystemView> = {}): SystemView => ({ key: '10.0.0.2', handle: 1, name: 'P', ip: '10.0.0.2', mac: '', state, role: 'player', connected: true, outputs: [], perf: [], renderFps: null, gpuTemp: null, cpuLoad: null, gpuLoad: null, ...extra });
  it.each([
    ['Engine Opened', []],
    ['Lost', ['critical']],
    ['Engine Open Failed', ['critical']],
    ['Engine Closed', ['critical']],
    ['Engine Closing For Restart', ['warning']],
    ['Something New', ['warning']]
  ])('state %s', (state, want) => {
    expect(systemAlerts(sys(state), DEFAULT_THRESHOLDS).map((a) => a.severity)).toEqual(want);
  });
});

describe('labelling', () => {
  it('names directors, the players in their projects and other Pixera machines', () => {
    const found = label(
      [{ host: '10.0.0.10', port: 1400, project: 'Show', apiRevision: 480, systems: [{ name: 'Dir', ip: '10.0.0.10', client: false, state: 'Engine Opened' }, { name: 'P1', ip: '10.0.0.11', client: true, state: 'Lost' }] }],
      ['10.0.0.11', '10.0.0.20']
    );
    expect(found.map((f) => [f.role, f.host, f.name, f.state])).toEqual([
      ['director', '10.0.0.10', 'Show', ''],
      ['player', '10.0.0.11', 'P1', 'Lost'],
      ['pixera', '10.0.0.20', '10.0.0.20', '']
    ]);
    expect(found[0]!.players).toBe(1);
  });

  it('finds a Pixera engine port with a bare connect', async () => {
    const engine = net.createServer((s) => s.end());
    await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r));
    const port = (engine.address() as net.AddressInfo).port;
    const found = await scan([{ host: '127.0.0.1', port: 1, enginePort: port }], 300);
    expect(found).toMatchObject([{ role: 'pixera', host: '127.0.0.1' }]);
    engine.close();
  });
});
