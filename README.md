# PointWeaver

PointWeaver plays your VEX LemLib autonomous routines top-down on the field. Open your PROS project folder and it:

- lists every auton from the selector,
- simulates it, and
- re-runs it every time you save a file.

It flags collisions, timed-out moves and the time limit. The model is kinematic, not physics: collisions are reported, and the robot drives straight through them.

## Install (teammates)

Get one of these from whoever builds it (they live in `release/`):

| File | What it is |
| --- | --- |
| `PointWeaver-Setup-<version>.exe` | Installer. Double-click it and PointWeaver lands in the Start menu. No admin rights needed. |
| `PointWeaver-<version>-portable.exe` | A single file that runs from anywhere, such as a USB stick or Downloads. It starts a little slower. |

The app isn't code-signed, so Windows may say *"Windows protected your PC"*. Click **More info → Run anyway**.

## Use

1. Click **Open folder** and pick the robot repo, meaning the folder that contains `src/`.
2. Pick a routine on the left. The names and order come from `kRoutines` in `selector.cpp`. ★ marks `kDefaultRoutine`, and files that aren't registered yet show under *Not in selector*.
3. Press ▶ or drag the timeline.
4. Edit the auton in VS Code and save. PointWeaver reloads and re-simulates on its own. The folder is remembered for next time.

| Control | Action |
| --- | --- |
| **Space** | Play / pause |
| **← / →** | Step 0.1 s (hold **Shift** for 1 s) |
| **Home** | Back to the start |
| **1 – 4** | Timeline · Collisions · Code · Settings |
| Click the field | Copies the `x, y` under the cursor |
| Click a row or a code line | Jumps to that moment |

The top bar shows the run time, collisions, timed-out moves and skipped lines. Click a count to open its list. The **15s / 60s** switch sets the limit; routines in a `skills` folder default to 60 s.

**Settings** (the sliders tab) has:

- which obstacles count as collisions;
- the robot's size, speed and acceleration;
- how long each blocking macro takes.

Measure these from the real robot so the timing means something.

## What it understands

| Code | Simulated as |
| --- | --- |
| `chassis.moveToPoint`, `moveToPose`, `turnToHeading`, `turnToPoint`, `swingToHeading`, `swingToPoint` | LemLib motions. Each takes the timeout, the swing's locked side, and `{.forwards, .maxSpeed, .minSpeed, .earlyExitRange, .direction, .lead}`. They are async, so the next line runs at once, and a new motion queues behind the current one like LemLib. |
| `chassis.donut(...)` | Crimson's orbit turn, with `fastSpeed` / `slowSpeed` |
| `chassis.waitUntilDone()`, `waitUntil(d)`, `cancelMotion()`, `setPose(...)` | Same as LemLib |
| `parallel({ [] { ... }, [] { ... } })` | The tasks run together, and the routine continues when all of them finish |
| `for (const double stage : {kStage1, kStage2})`, `for (int i = 0; i < 4; i++)` | One pass per value. The value is substituted into the body, so `flip_out(stage, …)` becomes `flip_out(kStage2, …)` on pass 2, and the timeline marks each pass |
| `pros::delay(ms)` | Waits |
| `macros::flip_out`, `dual_pickup`, … | Blocks for its **Macro time** |
| `claw::`, `intake::`, `intake_lift.set_value`, … | Instant |
| Math in arguments | `-24 + 7.5`, `chassis.getPose().theta + 90`, `M_PI` |

`setup()` runs right before `run()`. `if`, `while`, loops over named arrays and variables are skipped, and each skip shows a warning on its line.

## Develop

Requires [Node.js](https://nodejs.org) 20 or newer.

```sh
npm install
npm run app
npm run dist
npm test
```

- `npm run app` builds and opens the desktop app.
- `npm run dist` builds `release/PointWeaver-Setup-*.exe` and `release/PointWeaver-*-portable.exe`.
- `npm test` runs the parser, simulator and discovery tests.

| Script | Does |
| --- | --- |
| `npm run dev` + `npm run app:dev` | Live-reloading UI inside the desktop shell (F12 opens DevTools) |
| `npm run build` | `dist/index.html`, a single self-contained page that also works in a browser (it uses a folder upload instead of live reload) |
| `npm run typecheck` | Checks the app and the Electron code |

### Layout

```
electron/     desktop shell: window, folder picker, file watcher (main + preload)
src/
  core/       angles and 2D geometry
  field/      one file per season (override.ts)
  robot/      robot size and limits
  profiles/   team profile: chassis name, macro times, selector pattern (crimson.ts)
  program/    C++ reader -> AST -> C++ writer
  project/    finds routines in a project folder
  sim/        motions, the LemLib-style scheduler, collisions
  render/     SVG field and robot
  ui/         the app: panels, playback, saved state, icons
tests/        vitest suites
build/        app icon
```

The `core`, `field`, `program`, `project` and `sim` folders contain no browser or Electron code, so the tests and any future tools can reuse them.

### Extending

- **New season**: add `src/field/<game>.ts` and register it in `src/field/index.ts`.
- **Another team**: copy `src/profiles/crimson.ts`. Change the chassis name, macro times, instant-call prefixes and the selector `registry` pattern.
- **New LemLib call**: add it to `MOTION_COMMANDS` in `src/sim/commands.ts` and write a `Motion` in `src/sim/motions/`.
- **New version**: bump `version` in `package.json`, then run `npm run dist`.

## Roadmap: path planner

1. Drag waypoints on the field. The edits go to the AST, and `emitCpp` writes the routine back to the file the watcher is already tracking.
2. Snap points to goals and tiles, and add per-point headings and timeouts.
3. Show collisions live while dragging. The simulator already reports them for every frame.
4. Add path events ("start intake at 40%") that become `waitUntil` + macro calls.
5. Read robot measurements from a JSON file in the robot repo.
