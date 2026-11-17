# PIXERA Monitor module

A Rack Control Surface module; see README.md. Built like the other module repos (rcs-led-processor-module,
rcs-netgearAV-module): SDK linked from a rack-control-surface checkout, signed releases on every merge to master
(the default branch).

## Working agreement

Features go on a branch and a pull request. Zac reviews, then merges. Title PRs `feat: ...` for features and
`fix: ...` for fixes; the title decides the version bump.

## Real PIXERA systems

PIXERA directors and players are live show equipment. Reading from them is fine. **Ask Zac before sending any
control command to a real system** (blackout, identify, test pattern, engine restart, or any other `set`,
`restart`, `start`, `stop` or `close` method). Develop against the simulator (`src/sim`, `npm run sim`).

PIXERA is the source of truth: config and state hold only the module's own settings; start, restore and
reconnect only read; commands go out only on a confirmed operator action with Allow controls on.
