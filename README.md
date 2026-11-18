# PIXERA Monitor

A [Rack Control Surface](https://github.horinetech.com/rcs-releases/) module for AV Stumpfl PIXERA. It finds
PIXERA directors and players on the show network and labels them, and watches each director's project over
PIXERA's native API: every server (live system) with its state, render rate, GPU and CPU, its outputs with
their format, active state, identify and blackout, the timelines and their transport, the API revision and
the licence. The Stream Deck holds blackout per output, per server and everywhere, identify, the test
pattern and an engine restart for a player.

- **Servers**: a card per server, director and players: alerts, state, render fps, GPU temperature and load,
  CPU, outputs active and format, with BLACKOUT, IDENTIFY and TEST PATTERN as badges. Tap a card (or its key)
  to select it.
- **Outputs**: the selected server's outputs with their format, state and the projectors and screens assigned
  to them, and buttons for the selected output and server (with Allow controls on, each after a dialog).
- **Timeline**: every timeline of every director, playing first, with its timecode and frame rate.
- **Alerts**: every active alert, worst first, and the event log since the module started.
- **Setup**: directors by address and API port, found by **Scan network**, Allow controls and the alert limits.

The web view has the same pages with more detail: every performance value PIXERA reports, the MAC addresses,
the licence, the event log with filters and blackout of everything.

## Stream Deck

| Key | Does |
| --- | --- |
| 1-4 | Servers of every director (key 4 pages when there are more than 4). Press to select. Colour: selected, warning or critical |
| 5 | Alerts: how many are active. Press for the Alerts view |
| 6-9 | Outputs of the selected server (key 9 pages when there are more than 4). Press to select |
| 10 | Blackout of the selected output on / off |
| 11 | Identify on the selected output on / off |
| 12 | Test pattern on / off (PIXERA switches it for every output of the director's project) |
| 13 | Blackout of every output of the selected server on / off |
| 14 | Restart the PIXERA engine on the selected player |
| 15 | Blackout of every output of every server of every director on / off |

On a larger deck (an XL, 8×4, or a Stream Deck + XL, 9×4) the top row holds more servers with Alerts on its
last key, the rows between hold more outputs with output blackout at the end of the second row, and the
bottom row starts with identify, test pattern, server blackout and restart and ends with blackout of every
server. This needs controller 0.21.0 or later; older controllers show the 15-key layout.

Every command key needs a **second press within 3 seconds**: the first press only arms it (the key reads PRESS
AGAIN and the screen names the command). Any other key disarms it.

## PIXERA is the source of truth

Everything shown is read from PIXERA and kept only in memory. State holds which server and output the panel
shows; config holds the director list, the API port to scan, the alert limits and the Allow controls switch,
so named saves carry exactly those. Starting, restoring a save, resuming after a power cut and reconnecting
only read. The module sends a command only when someone presses a command key twice or confirms one in a
dialog, and only with **Allow controls** on in Setup (off by default). After a command it reads the director
again and shows what PIXERA then reports.

PIXERA's API takes no login (it limits access with its own IP allowlist), so the module keeps no secrets.

## What it reads and writes

PIXERA's native API: JSON-RPC 2.0 over TCP, in PIXERA's "JSON/TCP" framing (`pxr1`, the body length as a
32-bit little-endian number, then the JSON). Turn it on in PIXERA under Settings > API with a JSON/TCP entry
and a port (1400 here unless set), on the director. Players are read through the director's project.

| | Methods |
| --- | --- |
| Every poll (3 s) | `Utility.getApiRevision`, `LiveSystems.getLiveSystems`, `Session.getProjectName`, `Ui.getDisplayTestpattern`; per live system `getName`, `getIp`, `getState`, `getPerformanceMonitoringValuesJsonEx(handle, "system,outputsTotal")` (or `getPerformanceMonitoringValuesJson`); per output `Output.getIdentify` and `Projector.getBlackout` / `Screen.getBlackout` of what is assigned to it; `Timelines.getTimelines` and per timeline `getName`, `getTransportMode`, `getCurrentHMSF`, `getFps`, `getOpacity` |
| Every 15 s | per live system `getStructureJson` (outputs, resolution, refresh rate, enabled, active, `client`), `getMacAddress`, `getAllOutputs`, `Output.getName`, `getAssignedProjectors`, `getAssignedScreens`, and their names. PIXERA's documentation asks not to call `getStructureJson` often |
| Once per connection | `Utility.getHasFunction` for each control method, so only the controls this build has are offered; `Utility.getLicenseJson` every minute |
| Commands | Blackout: `Projectors.Projector.setBlackout` / `Screens.Screen.setBlackout` on every projector and screen assigned to the output, so the output keeps sending a signal. Identify: `LiveSystems.Output.setIdentify`. Test pattern: `Ui.setDisplayTestpattern`. Restart: `LiveSystems.LiveSystem.restartEngine`, or `Session.restartLiveSystem(ip)` on builds without it |

**Scan network** asks every address on the unit's /24 networks (or one you give) `Utility.getApiRevision` on
the API port; an address that answers is a director and is asked for its project and live systems, whose
`client` flag marks its players. It also tries a bare TCP connection (nothing sent) on 27101, PIXERA's engine
manager port, so a PIXERA machine in no answering director's project still shows.

Caveats, all from reading PIXERA's documentation and API listings rather than a real system:

- **Presence has no API.** "Restart" restarts the PIXERA engine that Presence runs on the player, through the
  director. Restarting the Presence app itself is a PIXERA Hub action only.
- **The test pattern is project-wide.** The API has `Ui.setDisplayTestpattern(display)` and nothing per
  output, so the per-output and per-server key is Identify, PIXERA's own identification pattern.
- **Blackout is by projector and screen.** PIXERA's API has no output blackout; an output with nothing
  assigned to it cannot be blacked out from here. A screen on two outputs blacks out on both.
- **The keys of the performance values are not documented.** The module shows every value it gets and picks
  render fps, GPU temperature and load and CPU load by name; check them against a real director.
- **The PIXERA version** is not in the API. The module shows the API revision (odd numbers are beta builds) and
  a version from the licence JSON when it carries one.
- **Commands have only been tried against the simulator.** Ask before pointing a development build with Allow
  controls on at real show equipment.

## Develop

Node.js 22 or later, and a checkout of the main `rack-control-surface` repo, which holds the SDK until it is
published to npm.

```sh
# next to this folder: git clone …/rack-control-surface && cd rack-control-surface && npm install && npm run build
npm install            # links the SDK from ../rack-control-surface when it is there
npm run link-sdk -- C:\src\rack-control-surface    # or point at a checkout somewhere else (or set RCS_REPO)
npm test               # API, rule and module tests against the simulator and the SDK's fake controller
npm run sim            # two simulated directors: "Main Show" on 127.0.0.1:1400 (two players), "B Stage" on :1401
RCS_PIXERA_SCAN=127.0.0.1:1400,127.0.0.1:1401 npm run dev
```

In the simulator (http://127.0.0.1:5173/sim) open the module's Setup and press Scan network, or add the
directors by address and port in the web view (http://127.0.0.1:5174). Start the simulator with a fault:
`npm run sim -- player-lost` (also `output-inactive`, `fps-drop`, `gpu-hot`, `old-build`; see
`src/sim/pixera.ts`). `RCS_PIXERA_POLL_MS` and `RCS_PIXERA_STRUCTURE_MS` read faster during development.

## Releasing

Every merge to `master` (the default branch) is a release (`.github/workflows/release.yml`), versioned from the
PR title: `feat:` is a minor bump, `!:` or `BREAKING CHANGE` a major one, anything else a patch; `[skip release]`
skips it. The workflow tests, stamps the version into `module.json`, packs, signs and publishes
`pixera-<version>.zip` and its `.sig` as a GitHub release here, where units find it through the module index in
[horinezachary/rcs-releases](https://github.com/horinezachary/rcs-releases).

It needs two Actions secrets:

- `RCS_SIGNING_KEY`: the module's private signing key, made with
  `node node_modules/@rcs/module-sdk/dist/pack-cli.js keygen`. Its public key is this module's entry in
  `index.json` in rcs-releases.
- `RCS_SOURCE_TOKEN`: a fine-grained token with Contents read-only on `rack-control-surface`, so the workflows
  can link the SDK from it. CI uses the tag in `package.json` `rcs.sdkRef`.

## Icon and colour

`assets/icon.svg` is the PIXERA mark (two triangles) without the wordmark, traced as one colour from the logo Zac
supplied. The accent colour (`theme` in `module.json`) is the logo's yellow, darkened in Light so it reads on
white. PIXERA is a trademark of AV Stumpfl GmbH. The mark is used only to show which software this module works
with. This module is not made or endorsed by AV Stumpfl.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | The module backend: views, keys, confirmations, config and the messages its UIs send |
| `src/monitor.ts` | Polls each director, keeps readings, alerts and events in memory, sends confirmed commands |
| `src/pixera/client.ts` | The JSON/TCP connection (`pxr1` framing) |
| `src/pixera/read.ts` | Everything read from a director |
| `src/pixera/control.ts` | The only code that sends commands |
| `src/rules.ts` | Health rules and alert limits |
| `src/scan.ts` | The read-only network scan and the director / player labels |
| `src/sim/`, `src/sim-cli.ts` | A simulated director with players, outputs and timelines, and switchable faults |
| `ui/index.html` | The panel UI |
| `web/index.html` | The web view's pages |
| `scripts/link-sdk.mjs` | Links `@rcs/*` from a main repo checkout |
