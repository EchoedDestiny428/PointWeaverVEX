# PointWeaver

PointWeaver is a path editor for VEX autons that writes LemLib code. It looks and works like the FRC PointWeaver app:

- An **auton** is a folder of short **paths**. A path can be reused in many autons, and each use can be turned 180° for the other half of the field.
- Click and drag points on the Override field. A ghost robot drives the auton through PointWeaver's LemLib simulator.
- The **Output code** tab has the auton's code, ready to copy into the robot project.

There's nothing to open. Everything saves on its own to `Documents\PointWeaver`.

## Install (teammates)

Get one of these from whoever builds it (they live in `release/`):

| File | What it is |
| --- | --- |
| `PointWeaver-Setup-<version>.exe` | Installer. Double-click it and PointWeaver lands in the Start menu. No admin rights needed. |
| `PointWeaver-<version>-portable.exe` | A single file that runs from anywhere, such as a USB stick or Downloads. It starts a little slower. |

The app isn't code-signed, so Windows may say *"Windows protected your PC"*. Click **More info → Run anyway**.

## Use

1. Click **+** next to **Autons** and name it.
2. Click **+** next to **Paths** on the right, then **New path…**. The path goes into the auton and opens.
3. Double-click the field to add points. Point 0 is where the path starts, and the robot drives to each point after it.
   While you drag a point, the robot is drawn where that point puts it, in red if it would hit the wall.
4. The goals, pins and loaders glow. Drag or double-click a point near one and it snaps there (hold **Ctrl** to place it freely):
   - **Goal**: the robot's centre drives to the goal's centre. It clips into the goal, so the code then waits and calls `chassis.setPoseFromGoal` with `.distance` set to **Goal** (7.5 in, robot centre to goal centre, under **Robot**). That puts the robot back where it really is, against the goal. You can switch the reset off per point. The ghost does the same reset, so it jumps back out of the goal (a dashed hop on the field), and the next move starts from there. A donut orbits the goal at that distance, so the robot ends up round the goal (the arc on the field) and the next move starts there.
   - **Pin or loader**: the robot stops where its claw's centre is on the spot. That's **Claw** (16 cm = 6.3 in) in front of the robot's centre, set under **Robot**. The robot faces the point's heading, or else the way it drives in.
5. Click a point to edit it on the right. Turn its heading on, then choose what happens there:
   - **Drive into**: `chassis.moveToPose`, arriving at that heading.
   - **Turn**: `chassis.moveToPoint`, then `chassis.turnToHeading` in place.
   - **Donut**: `chassis.moveToPoint`, then `chassis.donut`, Crimson's orbit turn. Only at a goal.

   With the heading off, the point is a plain `chassis.moveToPoint`. Turns and donuts have their own timeout, separate from the move's.

   **Face the next point** uses the direction to the next point instead of a number. Turn becomes `chassis.turnToPoint`, Donut donuts until the robot faces it, and Drive into arrives facing it. On point 0 it starts the robot facing point 1. When the next move is reversed, the robot's back faces it instead. The heading handle turns dashed; drag it to set your own heading again.
6. **Slow down for the last** (a slider on the point, or drag the diamond on the field) drives the last part of a move at **Slow max**.
7. Open the auton in the sidebar to see all of its paths. Add a path you already have with **+** in the auton's path list, or drag it in from **Paths** on the left. Click ↻ on a path to turn that use 180° about the field centre. The goals are placed point-symmetrically, so a move made on blue's half works the same way on red's half.
8. Open **Output code** and click the copy button.

Every path after the first starts by driving to its point 0, from wherever the path before it left the robot. That's a `moveToPoint` in `run()`, or a `moveToPose` if point 0 has a heading. It's skipped when the robot is already within 1 in, or when the path has **Set pose at start** on. Its timeout, speed and reverse are on point 0 of that path (open it from the auton).

Editing a path changes it in every auton that uses it, including the turned uses. You can edit a turned use where it sits on the field. The sidebar shows how many times each path is used.

| Control | Action |
| --- | --- |
| Double-click the field | Adds a point (on a segment, it goes between those two points) |
| Drag a point / its heading handle | Moves it / turns it (it snaps to goals, pins and loaders; hold **Ctrl** not to, **Alt** to snap to the 6 in grid, **Shift** to turn in 15° steps) |
| Drag the diamond on a move | Sets where its slowdown starts |
| Scroll over the selected point | Turns its heading 5° |
| **Shift**-click a point | Deletes it |
| **Shift**-drag on the field | Selects a group to move together |
| Drag the field, scroll | Pans, zooms |
| Click another path of the auton | Opens it |
| **Space** | Plays or pauses the ghost |
| **Esc** | Deselects the point. With nothing selected, goes back to the whole auton |
| **Del** | Deletes the selected points |
| **↑ / ↓** | Selects the previous or next point |
| **Ctrl+Z / Ctrl+Y** | Undo / redo |
| **Ctrl+S** | Saves now (changes also save on their own) |
| **F / G / V** | Fit the field / 6 in grid / color the ghost trail by speed |

The toolbar shows the ghost's run time. It turns bold with a ⚠ when the run is over the limit (15 s, or 60 s with **Skills** on), or when a move hits its timeout. That point gets a dashed ring.

**Robot** (bottom left) sets the ghost's size and speed, and the claw and goal offsets. Only the two offsets change the code.

## Output code

Each path becomes a function. A turned use gets a second function ending in `_rot180`. `run()` sets the start pose (point 0 of the first path) and calls the paths in order:

```cpp
void corner_rush() {
    chassis.moveToPoint(43.7, 72.4, 2000);
    chassis.moveToPose(47.8, 38.9, 180, 2000, {.forwards = false, .maxSpeed = 90});
}

void corner_rush_rot180() {
    chassis.moveToPoint(100.3, 71.6, 2000);
    chassis.moveToPose(96.2, 105.1, 0, 2000, {.forwards = false, .maxSpeed = 90});
}

void run() {
    chassis.setPose(17.7, 72.4, 0);
    corner_rush();
    corner_rush_rot180();
}
```

Settings that are left at LemLib's default stay out of the call. Each point can set **Timeout** (ms), **Exit** (`earlyExitRange`, in), **Max** and **Min** speed (0–127) and **Reverse** (`forwards = false`). Leave a box empty to use the path's default. Set the path's defaults with no point selected.

**Timeouts are estimated.** A timeout box left empty (on the point and the path) shows a greyed number: the ghost's time for that call, plus a quarter, plus **Leeway** (under **Robot**, 100 ms to start with), rounded up to 50 ms. That's what the code uses. Type a number to override it.

A goal, a pin and a slowdown look like this:

```cpp
chassis.moveToPoint(24, 48, 1050, {.forwards = false}); // blue goal 2
chassis.waitUntilDone();
chassis.setPoseFromGoal(24, 48, {.distance = 7.5});
chassis.moveToPoint(43.97, 52.84, 1750); // claw on yellow pin (48, 48)
chassis.moveToPoint(5.67, 17.79, 800); // claw on blue loader (2.4, 12.4)
chassis.waitUntil(17.67);
chassis.cancelMotion();
chassis.moveToPoint(5.67, 17.79, 650, {.maxSpeed = 40}); // last 50%
```

`.distance` is passed every time because `crimson::Chassis` on its own uses 22 cm (back against the goal) or 15 cm (front).

**Set pose at start** on a path adds a `chassis.setPose` at its point 0, for re-localising partway through an auton.

### Field frame

The coordinates match `include/constants/field_constants.hpp` in the robot repo. (0, 0) is the corner on blue's right as they face red. X and Y run from 0 to 144 in, with +X from the blue wall to the red wall. Heading 0 faces red and turns clockwise, so heading 90 faces −Y. On screen, blue is on the left.

## Files

Everything is plain JSON in `Documents\PointWeaver`. Click the folder button at the top left to open it.

```
Documents\PointWeaver\
  autons\<name>.json   the paths an auton runs, in order: [{ "path": "corner rush", "rotate": true }, ...]
  paths\<name>.json    a path's points and LemLib settings
  settings.json        the ghost's robot size and speed
```

Autons refer to paths by name, so renaming a path in the app updates every auton that uses it. In a plain browser (`npm run dev`), everything is kept in the browser's storage instead.

## Log tuning reports

The robot writes everything it measures to the SD card as `/usd/crimson_000N.wpilog`. `npm run analyze -- <log.wpilog>` writes `<log>.report.md` and `<log>.signals.csv` next to the log. Give both to Claude and ask for PID and odometry tuning. The files are standard WPILOG, so AdvantageScope can graph them too. (The app's old log replay view has been removed. The report command still works.)

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
- `npm test` runs the code generator, ghost, parser, simulator and log tests.

| Script | Does |
| --- | --- |
| `npm run dev` + `npm run app:dev` | Live-reloading UI inside the desktop shell (F12 opens DevTools) |
| `npm run dev` alone | The editor in a browser at http://localhost:5173, saving to browser storage |
| `npm run typecheck` | Checks the app, the Electron code and the CLI |
| `npm run analyze -- <log.wpilog>` | Writes the tuning report and signals CSV next to the log |
| `npm run sample` | Rebuilds `examples/sample.wpilog`, a synthetic match log made with the simulator |

### Layout

```
electron/        desktop shell: window, Documents\PointWeaver storage (main + preload)
src/
  App.tsx        the editor: sidebar, field, toolbar, right panel (React)
  editor/        autons and paths: types, path operations, LemLib code generator, ghost, storage
  features/      sidebar, field canvas and toolbar, point list, inspector, auton panel, code view
  hooks/         library state (undo, autosave), playback, theme
  components/    icons, number fields, toggles, menus
  core/          angles and 2D geometry
  field/         one file per season (override.ts)
  robot/         robot size and limits
  profiles/      team profile: chassis name, robot defaults (crimson.ts)
  program/       C++ reader -> AST -> C++ writer (the ghost runs the generated code through it)
  sim/           LemLib motions and scheduler
  log/           WPILOG reader and writer, tuning report
  project/       finds routines in a PROS project (used by the tests)
scripts/         CLI entry points (analyze, make-sample), built to dist-cli/
tests/           vitest suites
```

The look comes from the FRC PointWeaver app (`PointWeaverApp`). `App.css` is its stylesheet, and `vex.css` adds the auton folders, tabs and code view.

### Extending

- **New season**: add `src/field/<game>.ts` and register it in `src/field/index.ts`.
- **New LemLib call**: add it to `pointCalls` in `src/editor/codegen.ts`. For the ghost to drive it, add it to `MOTION_COMMANDS` in `src/sim/commands.ts`.
- **New version**: bump `version` in `package.json`, then run `npm run dist`.
