// Starts simulated PIXERA directors for development. Nothing here talks to real equipment.
//
//   npm run sim
//
// Then add them in Setup (127.0.0.1 port 1400 and 1401), or let Scan find them:
//   RCS_PIXERA_SCAN=127.0.0.1:1400,127.0.0.1:1401 npm run dev
// Switch faults on with a scenario: npm run sim -- player-lost  (see src/sim/pixera.ts for the list).
import { PixeraSimulator, type Scenario } from './sim/pixera.js';

const host = process.env.RCS_PIXERA_SIM_HOST ?? '127.0.0.1';
const main = new PixeraSimulator({ project: 'Main Show' });
const side = new PixeraSimulator({
  project: 'B Stage',
  apiRevision: 481,
  systems: [
    { name: 'B Director', ip: '10.10.31.10', client: false, outputs: [] },
    { name: 'B Player', ip: '10.10.31.11', client: true, outputs: [{ name: 'Downstage LED', screen: 'Downstage' }, { name: 'Lobby', screen: 'Lobby Screen', width: 1920, height: 1080, fps: 50 }] }
  ],
  timelines: [{ name: 'B Show' }]
});
const scenario = process.argv[2] as Scenario | undefined;
if (scenario) main.scenario = scenario;

const ports = [await main.listen(Number(process.env.RCS_PIXERA_SIM_PORT ?? 1400), host), await side.listen(Number(process.env.RCS_PIXERA_SIM_PORT ?? 1400) + 1, host)];
console.log(`PIXERA director "Main Show"  ${host}:${ports[0]} (JSON/TCP)${scenario ? `, scenario ${scenario}` : ''}`);
console.log(`PIXERA director "B Stage"    ${host}:${ports[1]} (JSON/TCP)`);

const stop = async () => {
  await Promise.all([main.close(), side.close()]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
