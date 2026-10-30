# PointWeaver

PointWeaver plays your VEX LemLib autonomous routines top-down on the field. Open your PROS project folder and it:

- lists every auton from the selector,
- simulates it, and
- re-runs it every time you save a file.

It flags collisions, timed-out moves and the time limit. The model is kinematic, not physics: collisions are reported, and the robot drives straight through them.

It also replays the robot's own `.wpilog` logs and writes a tuning report from them (see [Log replay & tuning reports](#log-replay--tuning-reports)).

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
| **1 – 4** | Timeline · Collisions · Code · Settings (with a log open: Log · Code · Settings) |
| **R** | Rotate the field background 90° (the ↻ button does the same). Paths, the robot and the coordinates stay where they are |
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
| `chassis.setPoseFromGoal(x, y, {.forwards, .distance, .maxCorrection})` | Crimson's goal snap: puts the robot's centre `distance` (7") behind its back (or in front with `.forwards = true`), along its heading. Like on the robot, it's skipped when that would move the robot more than `maxCorrection` (10") |
| `parallel({ [] { ... }, [] { ... } })` | The tasks run together, and the routine continues when all of them finish |
| `for (const double stage : {kStage1, kStage2})`, `for (int i = 0; i < 4; i++)` | One pass per value. The value is substituted into the body, so `flip_out(stage, …)` becomes `flip_out(kStage2, …)` on pass 2, and the timeline marks each pass |
| `pros::delay(ms)` | Waits |
| `macros::flip_out`, `dual_pickup`, … | Blocks for its **Macro time** |
| `claw::`, `intake::`, `intake_lift.set_value`, … | Instant |
| Math in arguments | `-24 + 7.5`, `chassis.getPose().theta + 90`, `M_PI` |

`setup()` runs right before `run()`. `if`, `while`, loops over named arrays and variables are skipped, and each skip shows a warning on its line.

## Log replay & tuning reports

On every run the robot writes everything it measures to the SD card as `/usd/crimson_000N.wpilog` (the next unused number), in inches and LemLib degrees.

1. Run an auton from the competition switch or field control.
2. Copy `crimson_000N.wpilog` off the SD card.
3. Click **Open log** at the bottom left, or drop the file anywhere on the window. Click a routine to go back to the simulator, and the log's row to return.

| Where | What you see |
| --- | --- |
| Field | **Robot**: the corrected pose and its trace. **Raw**: odometry that is never reset, as a dashed ghost. **Vision**: pose fixes as dots. **Target**: a crosshair (and heading ray) for the running motion. Dashed jumps mark each `setPose` / `setPoseFromGoal` correction; hover one for its `file:line`. If the open project has the logged routine (`/Auton/Selected`), its simulated path is drawn faintly underneath, so you can compare planned against actual |
| Legend | A colored square per series. The field and the graph use the same color. Click a chip to hide or show it; **×** removes a graphed channel |
| Graph | X, Y and heading for robot, raw and target, with auton and driver time shaded and each motion as a bar on top (amber = timed out). **+** graphs any logged channel (search `intake temp`, `battery volt`, …), up to four. Hover for values, click or drag to seek |
| Log tab | Values at the playhead, the analyzer's findings, and every motion and pose reset with its `file:line`. Click a row to jump there |
| Code tab | Highlights the line of the running motion |
| Top bar | Log length, timed-out motions, pose resets, the largest drift between corrected and raw odometry, and the lowest battery voltage. Click drift or battery to jump to that moment |

**Export report** (the download icon in the Log tab) writes `<log>.report.md` and `<log>.signals.csv` next to the log. These are the same files `npm run analyze -- <log>` makes. Give both to Claude and ask for PID and odometry tuning. The report covers each motion's error, timeout, overshoot and path deviation, each reset's jump and drift per 100 in driven, IMU drift, wheel slip, motor temperature and current, and battery sag.

The files are standard WPILOG, so AdvantageScope can graph them too.

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
- `npm test` runs the parser, simulator, discovery, log and replay tests.

| Script | Does |
| --- | --- |
| `npm run dev` + `npm run app:dev` | Live-reloading UI inside the desktop shell (F12 opens DevTools) |
| `npm run build` | `dist/index.html`, a single self-contained page that also works in a browser (it uses a folder upload instead of live reload) |
| `npm run typecheck` | Checks the app, the Electron code and the CLI |
| `npm run analyze -- <log.wpilog>` | Writes the tuning report `<log>.report.md` and the 50 Hz signals `<log>.signals.csv` next to the log |
| `npm run sample` | Rebuilds `examples/sample.wpilog`, a synthetic TeamBad match log made with the simulator |
| `npm run dev`, then `/?log=/examples/sample.wpilog&t=6` | Opens a log from a URL in the browser build (`t` seeks, `rotate=90` turns the field background, `tab=code` picks a tab) |

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
  log/        WPILOG reader and writer, replay model, tuning report, sample log
  render/     SVG field, robot, log replay and graph
  ui/         the app: panels, playback, saved state, icons
scripts/      CLI entry points (analyze, make-sample), built to dist-cli/
tests/        vitest suites
build/        app icon
```

The `core`, `field`, `program`, `project`, `sim` and `log` folders contain no browser or Electron code, so the tests and the CLI can reuse them.

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
