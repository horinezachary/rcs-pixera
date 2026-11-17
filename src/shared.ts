// The shapes the module reads from a PIXERA director and shows. Everything here lives in memory only:
// nothing read from Pixera is saved.

export type Severity = 'ok' | 'warning' | 'critical' | 'unknown';
export type Role = 'director' | 'player';
export type Transport = 'play' | 'pause' | 'stop' | 'unknown';

export interface Alert {
  key: string;
  rule: string;
  severity: 'warning' | 'critical';
  message: string;
  since: number;
  /** The server it is about, when it is about one. */
  system?: string;
}

export interface PerfValue {
  label: string;
  value: number | string;
}

/** Projectors and screens assigned to an output: the module's blackout acts on these. */
export interface OutputTarget {
  kind: 'projector' | 'screen';
  handle: number;
  name: string;
  blackout: boolean | null;
}

export interface OutputView {
  /** Stable within a director: "<system key>/<graphics device idPath>/<output idPath>". */
  key: string;
  /** API handle of the output, when Pixera gave one. */
  handle: number | null;
  device: string;
  name: string;
  enabled: boolean;
  active: boolean;
  width: number | null;
  height: number | null;
  /** Output refresh rate from the output structure. */
  fps: number | null;
  identify: boolean | null;
  targets: OutputTarget[];
  /** 'on': every target blacked out; 'partial': some; 'off': none; 'none': nothing assigned to black out. */
  blackout: 'on' | 'off' | 'partial' | 'none';
}

export interface SystemView {
  /** Stable within a director: the IP, or the name when the system reports no IP. */
  key: string;
  handle: number;
  name: string;
  ip: string;
  mac: string;
  /** Pixera's own state string, e.g. "Engine Opened", "Lost". */
  state: string;
  role: Role;
  connected: boolean | null;
  outputs: OutputView[];
  perf: PerfValue[];
  /** Picked out of the performance values when Pixera reports them. */
  renderFps: number | null;
  gpuTemp: number | null;
  cpuLoad: number | null;
  gpuLoad: number | null;
}

export interface TimelineView {
  handle: number;
  name: string;
  transport: Transport;
  time: string;
  fps: number | null;
  opacity: number | null;
}

/** The methods a director has, asked once per connection with Pixera.Utility.getHasFunction (a read). */
export interface Capabilities {
  testPattern: boolean;
  identify: boolean;
  projectorBlackout: boolean;
  screenBlackout: boolean;
  restartEngine: boolean;
  restartLiveSystem: boolean;
}

export interface DirectorReading {
  apiRevision: number | null;
  /** Beta builds have odd API revisions. */
  beta: boolean;
  version: string;
  projectName: string;
  license: PerfValue[];
  testPattern: boolean | null;
  systems: SystemView[];
  timelines: TimelineView[];
  caps: Capabilities;
}

export interface DirectorView extends Partial<DirectorReading> {
  id: string;
  host: string;
  port: number;
  name: string;
  reachable: boolean;
  lastSeen?: number;
  lastError?: string;
  missedPolls: number;
  systems: SystemView[];
  timelines: TimelineView[];
  alerts: Alert[];
  severity: Severity;
}

export type ControlRequest =
  | { action: 'blackout'; scope: 'output'; system: string; output: string; value: boolean }
  | { action: 'blackout'; scope: 'system'; system: string; value: boolean }
  | { action: 'blackout'; scope: 'all'; value: boolean }
  | { action: 'identify'; scope: 'output'; system: string; output: string; value: boolean }
  | { action: 'identify'; scope: 'system'; system: string; value: boolean }
  | { action: 'testPattern'; value: boolean }
  | { action: 'restart'; system: string };

export const SEVERITY_ORDER: Severity[] = ['ok', 'unknown', 'warning', 'critical'];
export function worstSeverity(list: Severity[]): Severity {
  return list.reduce<Severity>((w, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(w) ? s : w), 'ok');
}
