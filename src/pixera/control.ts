// The only code that changes anything on PIXERA. The module calls it only for a confirmed operator action
// with Allow controls on (see index.ts); polling, starting, restoring and reconnecting never reach it.
//
//   Blackout     Pixera.Projectors.Projector.setBlackout / Pixera.Screens.Screen.setBlackout on every
//                projector and screen assigned to the output (Output.getAssignedProjectors / getAssignedScreens).
//                The output keeps sending a signal, so LED processors and projectors downstream keep sync.
//   Identify     Pixera.LiveSystems.Output.setIdentify: Pixera's own identification pattern on the output.
//   Test pattern Pixera.Ui.setDisplayTestpattern: Pixera's test pattern, which the director switches for
//                every output of the project at once (the API has no per-output test pattern).
//   Restart      Pixera.LiveSystems.LiveSystem.restartEngine on the player's live system, or on builds without
//                it Pixera.Session.restartLiveSystem(ip). This restarts the PIXERA engine that Presence runs on
//                the player; Presence itself has no API.
import type { Rpc } from './client.js';
import type { ControlRequest, DirectorReading, OutputView, SystemView } from '../shared.js';

export class ControlError extends Error {}

export function findSystem(r: Pick<DirectorReading, 'systems'>, key: string): SystemView {
  const s = r.systems.find((x) => x.key === key);
  if (!s) throw new ControlError('That server is no longer in the director’s project.');
  return s;
}

export function findOutput(s: SystemView, key: string): OutputView {
  const o = s.outputs.find((x) => x.key === key);
  if (!o) throw new ControlError(`That output is no longer on ${s.name}.`);
  return o;
}

/** The outputs a request acts on. */
export function outputsFor(r: Pick<DirectorReading, 'systems'>, req: ControlRequest): OutputView[] {
  if (req.action === 'testPattern' || req.action === 'restart') return [];
  if (req.scope === 'all') return r.systems.flatMap((s) => s.outputs);
  const s = findSystem(r, req.system);
  return req.scope === 'system' ? s.outputs : [findOutput(s, req.output)];
}

/** Checks a request against the last reading and the director's capabilities. Throws ControlError. */
export function check(r: DirectorReading, req: ControlRequest): void {
  const c = r.caps;
  switch (req.action) {
    case 'testPattern':
      if (!c.testPattern) throw new ControlError('This Pixera build has no test pattern in its API.');
      return;
    case 'restart': {
      const s = findSystem(r, req.system);
      if (s.role !== 'player') throw new ControlError(`${s.name} is the director: the module restarts players only.`);
      if (!c.restartEngine && !(c.restartLiveSystem && s.ip)) throw new ControlError('This Pixera build cannot restart a player over its API.');
      return;
    }
    case 'identify': {
      if (!c.identify) throw new ControlError('This Pixera build cannot identify outputs over its API.');
      if (!outputsFor(r, req).some((o) => o.handle !== null)) throw new ControlError('Pixera gave no output handles for that.');
      return;
    }
    case 'blackout': {
      if (!c.projectorBlackout && !c.screenBlackout) throw new ControlError('This Pixera build cannot black out projectors or screens over its API.');
      if (!outputsFor(r, req).some((o) => o.targets.length)) throw new ControlError('No projector or screen is assigned to that, so there is nothing to black out.');
      return;
    }
  }
}

export async function send(rpc: Rpc, r: DirectorReading, req: ControlRequest): Promise<void> {
  check(r, req);
  switch (req.action) {
    case 'testPattern':
      await rpc.request('Pixera.Ui.setDisplayTestpattern', { display: req.value });
      return;
    case 'restart': {
      const s = findSystem(r, req.system);
      if (r.caps.restartEngine) await rpc.request('Pixera.LiveSystems.LiveSystem.restartEngine', { handle: s.handle });
      else await rpc.request('Pixera.Session.restartLiveSystem', { ip: s.ip });
      return;
    }
    case 'identify':
      for (const o of outputsFor(r, req)) if (o.handle !== null) await rpc.request('Pixera.LiveSystems.Output.setIdentify', { handle: o.handle, state: req.value });
      return;
    case 'blackout': {
      // A screen can sit on more than one output: send each target once.
      const seen = new Set<string>();
      for (const o of outputsFor(r, req)) {
        for (const t of o.targets) {
          const k = `${t.kind}:${t.handle}`;
          if (seen.has(k)) continue;
          seen.add(k);
          if (t.kind === 'projector' && r.caps.projectorBlackout) await rpc.request('Pixera.Projectors.Projector.setBlackout', { handle: t.handle, isActive: req.value });
          if (t.kind === 'screen' && r.caps.screenBlackout) await rpc.request('Pixera.Screens.Screen.setBlackout', { handle: t.handle, isActive: req.value });
        }
      }
      return;
    }
  }
}

/** The command in words, for the confirmation and the event log. */
export function describe(req: ControlRequest, r?: Pick<DirectorReading, 'systems'>, director = 'the director'): string {
  const sys = (k: string) => r?.systems.find((s) => s.key === k)?.name ?? k;
  const out = (s: string, o: string) => `${r?.systems.find((x) => x.key === s)?.outputs.find((x) => x.key === o)?.name ?? 'the output'} of ${sys(s)}`;
  const black = (v: boolean, what: string) => (v ? `black out ${what}` : `lift the blackout on ${what}`);
  switch (req.action) {
    case 'testPattern':
      return `turn the test pattern ${req.value ? 'on' : 'off'} for every output of ${director}`;
    case 'restart':
      return `restart the PIXERA engine on ${sys(req.system)}`;
    case 'identify':
      return `turn identify ${req.value ? 'on' : 'off'} for ${req.scope === 'output' ? out(req.system, req.output) : `every output of ${sys(req.system)}`}`;
    case 'blackout':
      return black(req.value, req.scope === 'output' ? out(req.system, req.output) : req.scope === 'system' ? `every output of ${sys(req.system)}` : `every output of every server of ${director}`);
  }
}
