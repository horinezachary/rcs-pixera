// The module against simulated PIXERA directors and the SDK's fake controller: the source-of-truth rules
// (start, restore and reconnect only read; commands only on a confirmed operator action with Allow controls
// on), labelling, alerts, the keys and the web view's messages.
import { startTestModule, type TestModule } from '@rcs/module-sdk/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mod, { KEY, type Config, type State } from '../src/index.js';
import { DEFAULT_THRESHOLDS } from '../src/rules.js';
import { PixeraSimulator, type PixeraSimOptions } from '../src/sim/pixera.js';

let sim: TestModule<State, Config> | null = null;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
  process.env.RCS_PIXERA_POLL_MS = '150';
  process.env.RCS_PIXERA_STRUCTURE_MS = '100';
});

afterEach(async () => {
  // The controller refuses longer key and strip labels (protocol limits.ts).
  for (const k of sim?.keys ?? []) {
    expect([...(k?.label ?? '')].length).toBeLessThanOrEqual(10);
    expect([...(k?.sublabel ?? '')].length).toBeLessThanOrEqual(12);
  }
  for (const i of sim?.strip ?? []) expect([...i.label].length).toBeLessThanOrEqual(8);
  await sim?.close();
  sim = null;
  while (cleanups.length) await cleanups.pop()!();
  delete process.env.RCS_PIXERA_SCAN;
});

const last = () => (sim ? [...sim.uiMessages].reverse().find((m) => m.message?.type === 'snapshot')?.message : null);

async function until(check: () => boolean, ms = 5000, what = ''): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`timed out ${what}: ${JSON.stringify(last()?.directors?.map((d: any) => [d.name, d.reachable, d.lastError]))} ${sim?.errors.map(String)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function director(o: PixeraSimOptions = {}) {
  const p = new PixeraSimulator({ restartMs: 300, ...o });
  const port = await p.listen();
  cleanups.push(() => p.close());
  return { p, port };
}

const entry = (id: string, port: number) => ({ id, host: '127.0.0.1', port, label: '' });

async function start(directors: Config['directors'], extra: { allow?: boolean; state?: State; reason?: 'boot' | 'restore' | 'user'; deck?: { columns: number; rows: number } } = {}) {
  const config: Config = { directors, thresholds: DEFAULT_THRESHOLDS, scanPort: 1400, allowControls: extra.allow ?? false };
  sim = await startTestModule(mod, { config, state: extra.state, reason: extra.reason, deck: extra.deck });
  await sim.settle();
  await until(() => last()?.directors?.length === directors.length && last().directors.every((d: any) => d.reachable && d.systems.length), 5000, 'for the directors');
  await sim.settle();
  return sim;
}

const server = (name: string) => last().directors.flatMap((d: any) => d.systems).find((s: any) => s.name === name);

describe('PIXERA is the source of truth', () => {
  it.each(['boot', 'restore', 'user'] as const)('only reads on a %s start, whatever the save says', async (reason) => {
    const { p, port } = await director();
    await start([entry('00000001', port)], { allow: true, reason, state: { director: '00000001', system: '10.10.30.12', output: '' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(p.writes).toEqual([]);
    expect(p.calls.every((m) => /\.(get[A-Za-z]*)$/.test(m))).toBe(true);
    expect(last().current).toMatchObject({ director: '00000001', system: '10.10.30.12' });
    expect(Object.keys(sim!.state).sort()).toEqual(['director', 'output', 'system']);
    expect(JSON.stringify(sim!.config)).not.toMatch(/Main Show|Player|Engine/);
  });

  it('reconnect only reads', async () => {
    const { p, port } = await director();
    await start([entry('00000001', port)], { allow: true });
    await sim!.sendUi({ type: 'reconnect' });
    await new Promise((r) => setTimeout(r, 300));
    expect(p.writes).toEqual([]);
  });

  it('keeps the last readings marked unreachable when a director stops answering', async () => {
    const { p, port } = await director();
    await start([entry('00000001', port)]);
    await p.close();
    await until(() => last().directors[0].reachable === false, 3000, 'for the drop');
    expect(last().directors[0].systems).toHaveLength(3);
    expect(sim!.status?.connection).toBe('disconnected');
  });
});

describe('reading', () => {
  it('labels the director and its players and reads versions, outputs and timelines', async () => {
    const { port } = await director();
    await start([entry('00000001', port)]);
    const d = last().directors[0];
    expect(d).toMatchObject({ name: 'Main Show', apiRevision: 480, beta: false, version: '26.1 R39', testPattern: false });
    expect(d.systems.map((s: any) => [s.name, s.role])).toEqual([
      ['Director', 'director'],
      ['Player 1', 'player'],
      ['Player 2', 'player']
    ]);
    const p1 = server('Player 1');
    expect(p1).toMatchObject({ ip: '10.10.30.11', state: 'Engine Opened', renderFps: 60, gpuTemp: 64 });
    expect(p1.outputs[0]).toMatchObject({ name: 'LED Main L', width: 3840, height: 2160, fps: 60, active: true, blackout: 'off', identify: false });
    expect(p1.outputs[0].targets).toEqual([{ kind: 'screen', handle: expect.any(Number), name: 'LED Wall Left', blackout: false }]);
    expect(d.timelines[0]).toMatchObject({ name: 'Show', transport: 'play', fps: 60 });
    expect(d.timelines[0].time).toMatch(/^00:12:3\d:\d\d$/);
    // The panel starts on the first player.
    expect(last().current.system).toBe('10.10.30.11');
  });

  it.each([
    ['player-lost', 'Player 2', 'critical', /lost/],
    ['output-inactive', 'Player 1', 'warning', /LED Main R is enabled but not active/],
    ['fps-drop', 'Player 1', 'warning', /rendering 50 fps, outputs run at 60/],
    ['gpu-hot', 'Player 1', 'critical', /GPU at 92/]
  ] as const)('raises an alert for %s', async (scenario, name, severity, re) => {
    const { p, port } = await director();
    await start([entry('00000001', port)]);
    p.scenario = scenario;
    await until(() => last().alerts.some((a: any) => re.test(a.message)), 3000, 'for the alert');
    expect(last().alerts.find((a: any) => re.test(a.message))).toMatchObject({ severity, message: expect.stringContaining(name) });
    expect(server(name).severity).toBe(severity);
    p.scenario = 'normal';
    await until(() => !last().alerts.length, 3000, 'for the alert to clear');
    expect(last().events.map((e: any) => e.message).join('\n')).toMatch(/cleared/);
  });
});

describe('controls', () => {
  it('sends nothing with Allow controls off', async () => {
    const { p, port } = await director();
    await start([entry('00000001', port)]);
    for (const k of [KEY.OUT_BLACKOUT, KEY.SYS_BLACKOUT, KEY.ALL_BLACKOUT, KEY.RESTART, KEY.TEST, KEY.IDENTIFY]) {
      await sim!.press(k);
      await sim!.press(k);
    }
    await sim!.sendUi({ type: 'control', director: '00000001', req: { action: 'testPattern', value: true }, from: 'web' });
    await sim!.settle();
    expect(p.writes).toEqual([]);
    expect(sim!.keys[KEY.ALL_BLACKOUT]).toMatchObject({ label: 'VIEW ONLY' });
  });

  it('blacks out the selected output on the second press only, through its screen', async () => {
    const { p, port } = await director();
    await start([entry('00000001', port)], { allow: true });
    expect(sim!.keys[KEY.OUT[0]]).toMatchObject({ label: 'LED MAIN L' });
    await sim!.press(KEY.OUT_BLACKOUT);
    await sim!.settle();
    expect(p.writes).toEqual([]);
    expect(sim!.keys[KEY.OUT_BLACKOUT]).toMatchObject({ sublabel: 'PRESS AGAIN' });
    expect(last().armed.what).toBe('black out LED Main L of Player 1');
    await sim!.press(KEY.OUT_BLACKOUT);
    await until(() => server('Player 1').outputs[0].blackout === 'on', 3000, 'for the read-back');
    expect(p.writes).toEqual([{ method: 'Pixera.Screens.Screen.setBlackout', params: { handle: expect.any(Number), isActive: true } }]);
    expect(server('Player 1').outputs[0].blackout).toBe('on');
    expect(sim!.keys[KEY.OUT_BLACKOUT]).toMatchObject({ sublabel: 'OUTPUT ON' });
  });

  it('picks another server\'s output from a tall panel, disarms, and the output keys follow it', async () => {
    const { p, port } = await director();
    await start([entry('00000001', port)], { allow: true });
    await sim!.press(KEY.OUT_BLACKOUT);
    await sim!.settle();
    expect(last().armed?.what).toBeTruthy();
    const imag = server('Player 2').outputs[1];
    await sim!.sendUi({ type: 'select-output', director: '00000001', system: '10.10.30.12', output: imag.key });
    await sim!.settle();
    expect(last().current).toMatchObject({ director: '00000001', system: '10.10.30.12', output: imag.key });
    expect(last().armed).toBeNull();
    expect(sim!.keys[KEY.OUT[0]]).toMatchObject({ label: 'IMAG L' });
    await sim!.sendUi({ type: 'select-output', director: '00000001', system: '10.10.30.12', output: 'nope' });
    expect(last().current.output).toBe(imag.key);
    expect(p.writes).toEqual([]);
  });

  it('lets another key disarm, and a slow second press only arms again', async () => {
    const { p, port } = await director();
    await start([entry('00000001', port)], { allow: true });
    await sim!.press(KEY.SYS_BLACKOUT);
    await sim!.press(KEY.IDENTIFY);
    await sim!.press(KEY.SYS_BLACKOUT);
    await sim!.settle();
    expect(p.writes).toEqual([]);
  });

  it('blacks out a whole server: projectors and screens', async () => {
    const { p, port } = await director();
    await start([entry('00000001', port)], { allow: true });
    await sim!.press(KEY.SYS_BLACKOUT);
    await sim!.press(KEY.SYS_BLACKOUT);
    await until(() => server('Player 1').blackout === 'on', 3000, 'for the read-back');
    expect(p.writes.map((w) => w.method).sort()).toEqual(['Pixera.Projectors.Projector.setBlackout', 'Pixera.Projectors.Projector.setBlackout', 'Pixera.Screens.Screen.setBlackout', 'Pixera.Screens.Screen.setBlackout']);
    expect(server('Player 1').blackout).toBe('on');
    expect(server('Player 2').blackout).toBe('off');
  });

  it('blacks out every server of every director, and back', async () => {
    const a = await director();
    const b = await director({ project: 'B Stage', systems: [{ name: 'B Player', ip: '10.10.31.11', client: true, outputs: [{ name: 'Lobby', screen: 'Lobby' }] }] });
    await start([entry('00000001', a.port), entry('00000002', b.port)], { allow: true });
    await sim!.press(KEY.ALL_BLACKOUT);
    await sim!.press(KEY.ALL_BLACKOUT);
    await until(() => last().allBlackout === 'on', 3000, 'for the read-back');
    expect(a.p.writes).toHaveLength(6);
    expect(b.p.writes).toHaveLength(1);
    expect(last().allBlackout).toBe('on');
    await sim!.sendUi({ type: 'control', director: '*', req: { action: 'blackout', scope: 'all', value: false }, from: 'web' });
    await until(() => last().allBlackout === 'off', 3000, 'for the read-back');
    expect(last().allBlackout).toBe('off');
    expect(b.p.writes.at(-1)).toMatchObject({ params: { isActive: false } });
  });

  it('switches the test pattern and identify', async () => {
    const { p, port } = await director();
    await start([entry('00000001', port)], { allow: true });
    await sim!.press(KEY.TEST);
    await sim!.press(KEY.TEST);
    await until(() => last().directors[0].testPattern === true, 3000, 'for the read-back');
    expect(p.writes).toEqual([{ method: 'Pixera.Ui.setDisplayTestpattern', params: { display: true } }]);
    expect(last().directors[0].testPattern).toBe(true);
    expect(last().alerts.some((a: any) => /test pattern is on/.test(a.message))).toBe(true);
    await sim!.sendUi({ type: 'control', director: '00000001', req: { action: 'identify', scope: 'system', system: '10.10.30.12', value: true }, from: 'web' });
    await until(() => server('Player 2').outputs.every((o: any) => o.identify), 3000, 'for the read-back');
    expect(p.writes.slice(1).map((w) => w.method)).toEqual(['Pixera.LiveSystems.Output.setIdentify', 'Pixera.LiveSystems.Output.setIdentify']);
    expect(server('Player 2').outputs.every((o: any) => o.identify)).toBe(true);
  });

  it('restarts the engine on a player, not on the director', async () => {
    const { p, port } = await director();
    await start([entry('00000001', port)], { allow: true });
    await sim!.press(KEY.SYS[0]); // the director's own system
    await sim!.settle();
    expect(sim!.keys[KEY.RESTART]?.label).toBeUndefined();
    await sim!.sendUi({ type: 'control', director: '00000001', req: { action: 'restart', system: '10.10.30.10' }, from: 'web' });
    await sim!.settle();
    expect(p.writes).toEqual([]);
    expect(sim!.notifications.at(-1)?.text).toMatch(/restarts players only/);
    await sim!.press(KEY.SYS[1]);
    await sim!.press(KEY.RESTART);
    await sim!.press(KEY.RESTART);
    await until(() => /restart/i.test(server('Player 1').state), 3000, 'for the restart');
    expect(p.writes).toEqual([{ method: 'Pixera.LiveSystems.LiveSystem.restartEngine', params: { handle: expect.any(Number) } }]);
    await until(() => server('Player 1').state === 'Engine Opened', 3000, 'for the engine to come back');
  });

  it('on an older build, restarts by address and leaves out what the build lacks', async () => {
    const { p, port } = await director();
    p.scenario = 'old-build';
    await start([entry('00000001', port)], { allow: true });
    expect(last().directors[0].caps).toMatchObject({ testPattern: false, restartEngine: false });
    expect(sim!.keys[KEY.TEST]?.label).toBeUndefined();
    // getHasFunction is missing too, so nothing is offered at all: the module never guesses a method.
    expect(sim!.keys[KEY.RESTART]).toMatchObject({ sublabel: 'PLAYER 1' });
    await sim!.press(KEY.RESTART);
    await sim!.settle();
    expect(sim!.keys[KEY.RESTART].sublabel).not.toBe('PRESS AGAIN');
    expect(p.writes).toEqual([]);
  });
});

describe('setup and discovery', () => {
  it('adds, renames and removes directors in its own config only', async () => {
    const { p, port } = await director();
    sim = await startTestModule(mod, { config: { directors: [], thresholds: DEFAULT_THRESHOLDS, scanPort: 1400, allowControls: false } });
    await sim.settle();
    expect(sim.status).toMatchObject({ connection: 'disconnected' });
    await sim.sendUi({ type: 'add', host: '127.0.0.1', port });
    await until(() => last()?.directors?.[0]?.reachable, 3000, 'for the new director');
    const id = sim.config.directors[0]!.id;
    await sim.sendUi({ type: 'edit', id, label: 'FOH' });
    await until(() => last().directors[0].name === 'FOH');
    await sim.sendUi({ type: 'remove', id });
    await sim.settle();
    expect(sim.config.directors).toEqual([]);
    expect(p.writes).toEqual([]);
  });

  it('scans: finds directors and the players their projects name', async () => {
    const { p, port } = await director();
    process.env.RCS_PIXERA_SCAN = `127.0.0.1:${port}:1`;
    sim = await startTestModule(mod, { config: { directors: [], thresholds: DEFAULT_THRESHOLDS, scanPort: 1400, allowControls: false } });
    await sim.sendUi({ type: 'scan' });
    await until(() => last()?.found?.length === 3, 5000, 'for the scan');
    expect(last().found.map((f: any) => [f.role, f.name, f.host])).toEqual([
      ['director', 'Main Show', '127.0.0.1'],
      ['player', 'Player 1', '10.10.30.11'],
      ['player', 'Player 2', '10.10.30.12']
    ]);
    expect(p.writes).toEqual([]);
  });
});

describe('a larger Stream Deck', () => {
  it('spreads servers, outputs and commands over an XL, and goes back to 15 keys on a smaller deck', async () => {
    const { p, port } = await director();
    await start([entry('00000001', port)], { allow: true, deck: { columns: 8, rows: 4 } });
    expect(sim!.keys).toHaveLength(32);
    expect(sim!.keys[7]).toMatchObject({ label: 'ALERTS' });
    expect(sim!.keys[8]).toMatchObject({ label: 'LED MAIN L' }); // outputs start on the second row
    expect(sim!.keys[15]).toMatchObject({ label: 'BLACKOUT' }); // output blackout ends it
    expect(sim!.keys[24]).toMatchObject({ label: 'IDENTIFY' });
    expect(sim!.keys[31]).toMatchObject({ label: 'BLACKOUT', sublabel: 'ALL SERVERS' });
    await sim!.press(15);
    expect(sim!.keys[15]).toMatchObject({ sublabel: 'PRESS AGAIN' });
    await sim!.press(15);
    await until(() => server('Player 1').outputs[0].blackout === 'on', 3000, 'for the read-back');
    expect(p.writes).toHaveLength(1);

    await sim!.setDeck(5, 3);
    await sim!.settle();
    expect(sim!.keys).toHaveLength(15);
    expect(sim!.keys[KEY.ALERTS]).toMatchObject({ label: 'ALERTS' });
    expect(sim!.keys[KEY.OUT[0]]).toMatchObject({ label: 'LED MAIN L' });
    expect(sim!.keys[KEY.ALL_BLACKOUT]).toMatchObject({ label: 'BLACKOUT' });
  });
});
