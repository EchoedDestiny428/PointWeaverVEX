import { useEffect, useRef } from 'react';
import type { PathDefinition } from '../../editor/types';
import { FIELD_SIZE } from '../../editor/types';
import type { HistoryMode } from '../../hooks/useLibrary';
import type { Playback } from '../../hooks/usePlayback';
import type { Theme } from '../../hooks/useTheme';
import type { RobotConfig } from '../../robot/config';
import { poseAt, type GhostPose } from '../../editor/ghost';
import { speedColor, speedStops } from '../../utils/speedColor';
import {
  clampToField, insertPoint, offsetPoints, removePoint, resolveParams, round1, updatePoint, wrapDeg, type PointStart,
} from '../../editor/pathOps';
import { drawField } from './fieldArt';

/** Another path of the auton, drawn under (or, in the auton view, as) the paths you see. */
export interface StepPath {
  step: number;
  /** as the auton drives it */
  def: PathDefinition;
}

interface Props {
  /** the path being edited (as shown), or null in the auton view / with nothing open */
  path: PathDefinition | null;
  /** the auton's steps: faint context while editing one, the whole picture in the auton view */
  steps: StepPath[];
  /** which step is being edited (left out of the context) */
  activeStep: number | null;
  /** auton view: the step under the cursor (from the list or the field) */
  hoverStep: number | null;
  onHoverStep: (k: number | null) => void;
  /** click a path of the auton: open that step */
  onPickStep: (k: number) => void;
  /** the one selected point (null when none, or when a group is selected) */
  selectedIndex: number | null;
  /** every selected point: none, one, or a box-selected group */
  selection: number[];
  hoverIndex: number | null;
  onSelect: (i: number | null) => void;
  onSelectMany: (indices: number[]) => void;
  onHover: (i: number | null) => void;
  update: (def: PathDefinition, mode?: HistoryMode) => void;
  checkpoint: () => void;
  playback: Playback;
  /** points of the edited path whose move timed out in the ghost */
  timeouts: number[];
  fitToken: number;
  theme: Theme;
  robot: RobotConfig;
  /** draw the 6 in grid lines (the tile seams and edge rulers are always drawn) */
  grid: boolean;
  /** draw the ghost's trail colored by speed instead of the plain dashed trail */
  speedColors: boolean;
  emptyHint: string;
}

// screen-space sizes (CSS px), constant at any zoom
const R_POINT = 5.5;
const R_TRANS = 4;
const HEADING_LEN = 24;
const HIT_POINT = 10;
const HIT_TIP = 8;
const HIT_LINE = 6;
const FIT_MARGIN = 30;
const FIT_BOTTOM = 76; // room for the toolbar
const HIT_TRAIL = 6;
const SPEED_LEVELS = 48; // trail segments are batched by speed color, quantized to this many levels

const makePalette = (day: boolean) => {
  const a = (o: number) => (day ? `rgba(0,0,0,${o})` : `rgba(255,255,255,${o})`);
  return {
    bg: day ? '#ffffff' : '#000000',
    fg: day ? '#000000' : '#ffffff',
    grid: a(day ? 0.05 : 0.04),
    path: a(0.92),
    context: a(0.32),
    contextHot: a(0.75),
    ghostTrail: a(0.5),
    ghostFill: a(0.12),
    ring: a(0.3),
    ringSelected: a(0.65),
    halo: a(0.1),
    haloSelected: a(0.16),
    label: a(0.5),
    muted: a(0.6),
    start: a(0.3),
    startReset: a(0.75),
  };
};
const PALETTES = { night: makePalette(false), day: makePalette(true) };

type View = { scale: number; ox: number; oy: number };
type Drag =
  | { kind: 'point'; index: number; mode: 'position' | 'heading'; moved: boolean }
  // a selected group, dragged together; a click without dragging selects just the point that was clicked
  | { kind: 'group'; wx: number; wy: number; start: PointStart[]; clicked: number; moved: boolean }
  // Shift + drag on empty field: box select (screen px); a click without dragging clears the selection
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; moved: boolean }
  // deselect: a left click (no drag) on empty field clears the selection; pick: it opens that step instead
  | { kind: 'pan'; x: number; y: number; moved: boolean; deselect: boolean; pick: number | null };
type Hit = { index: number; mode: 'position' | 'heading' } | null;

/** Screen direction of a heading (0 = +X, clockwise; screen y points down, so it's just cos/sin). */
const dir = (theta: number): [number, number] => {
  const r = (theta * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
};

const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

export function FieldCanvas(props: Props) {
  const { fitToken } = props;
  const C = PALETTES[props.theme];
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const view = useRef<View>({ scale: 4, ox: 0, oy: 0 });
  const fitted = useRef(true);
  const drag = useRef<Drag | null>(null);
  const cursor = useRef<{ sx: number; sy: number; wx: number; wy: number } | null>(null);
  const hoveredTrail = useRef<{ speed: number; t: number; sx: number; sy: number } | null>(null);
  const dirty = useRef(true);
  const latest = useRef(props);
  latest.current = props;

  // ---- coordinate helpers ----
  const toScreen = (x: number, y: number): [number, number] => {
    const v = view.current;
    return [v.ox + x * v.scale, v.oy - y * v.scale];
  };
  const toWorld = (sx: number, sy: number) => {
    const v = view.current;
    return { x: (sx - v.ox) / v.scale, y: (v.oy - sy) / v.scale };
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  const fit = () => {
    const { w, h } = size.current;
    if (!w || !h) return;
    const aw = w - FIT_MARGIN * 2;
    const ah = h - FIT_MARGIN - FIT_BOTTOM;
    const scale = Math.max(0.5, Math.min(aw / FIELD_SIZE, ah / FIELD_SIZE));
    const ox = FIT_MARGIN + (aw - FIELD_SIZE * scale) / 2;
    const top = FIT_MARGIN + (ah - FIELD_SIZE * scale) / 2;
    view.current = { scale, ox, oy: top + FIELD_SIZE * scale };
    fitted.current = true;
    dirty.current = true;
  };

  // ---- sizing ----
  useEffect(() => {
    const el = containerRef.current!;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: width, h: height, dpr };
      const c = canvasRef.current!;
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      if (fitted.current) fit();
      // resizing clears the canvas: draw now, not next frame, so it never flashes empty (the code panel animates)
      drawRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    fit();
  }, [fitToken]);

  // redraw after any prop change
  useEffect(() => {
    dirty.current = true;
  });

  // ---- hit testing ----
  const hitTest = (sx: number, sy: number): Hit => {
    const pts = latest.current.path?.points ?? [];
    const selected = latest.current.selection.filter(i => i < pts.length);
    // selected points first (they're drawn on top), then the rest, last drawn first
    const order = [...selected, ...pts.map((_, i) => i).reverse().filter(i => !selected.includes(i))];
    for (const i of order) {
      const p = pts[i];
      const [px, py] = toScreen(p.x, p.y);
      if (p.theta != null) {
        const [dx, dy] = dir(p.theta);
        if (Math.hypot(sx - (px + dx * HEADING_LEN), sy - (py + dy * HEADING_LEN)) < HIT_TIP) {
          return { index: i, mode: 'heading' };
        }
      }
      if (Math.hypot(sx - px, sy - py) < HIT_POINT) return { index: i, mode: 'position' };
    }
    return null;
  };

  /** The auton step whose path runs under the cursor (not the one being edited). */
  const stepHit = (sx: number, sy: number): number | null => {
    const { steps, activeStep } = latest.current;
    let best: number | null = null;
    let bestD = HIT_LINE;
    for (const s of steps) {
      if (s.step === activeStep) continue;
      const pts = s.def.points.map(p => toScreen(p.x, p.y));
      for (let i = 0; i < pts.length; i++) {
        const d = i === 0
          ? Math.hypot(sx - pts[0][0], sy - pts[0][1])
          : distToSegment(sx, sy, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
        if (d < bestD) {
          bestD = d;
          best = s.step;
        }
      }
    }
    return best;
  };

  // ---- drawing ----
  const draw = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { w, h, dpr } = size.current;
    const { path, selection, hoverIndex, playback, grid, theme, steps } = latest.current;
    const v = view.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    drawField(ctx, toScreen, v.scale, theme);
    const [fx, fy] = toScreen(0, FIELD_SIZE);
    const fs = FIELD_SIZE * v.scale;

    if (grid) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      for (let d = 6; d < FIELD_SIZE; d += 6) {
        if (d % 24 === 0) continue; // tile seams are part of the field
        const sx = Math.round(fx + d * v.scale) + 0.5;
        ctx.moveTo(sx, fy);
        ctx.lineTo(sx, fy + fs);
        const sy = Math.round(fy + fs - d * v.scale) + 0.5;
        ctx.moveTo(fx, sy);
        ctx.lineTo(fx + fs, sy);
      }
      ctx.stroke();
    }

    drawRulers(ctx, fx, fy, fs);

    hoveredTrail.current = null;
    drawSteps(ctx, steps);
    if (path) drawPath(ctx, path, selection, hoverIndex);
    drawGhost(ctx, playback);
    if (latest.current.speedColors && playback.ghost.poses.length > 1) drawSpeedLegend(ctx);
    drawTooltips(ctx);

    // box select in progress
    const d = drag.current;
    if (d?.kind === 'box' && d.moved) {
      const bx = Math.min(d.x0, d.x1);
      const by = Math.min(d.y0, d.y1);
      const bw = Math.abs(d.x1 - d.x0);
      const bh = Math.abs(d.y1 - d.y0);
      ctx.fillStyle = C.halo;
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = C.muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(bw), Math.round(bh));
      ctx.setLineDash([]);
    }

    // cursor readout
    const c = cursor.current;
    if (c && c.wx >= 0 && c.wx <= FIELD_SIZE && c.wy >= 0 && c.wy <= FIELD_SIZE) {
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.fillStyle = C.label;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`x ${c.wx.toFixed(1)}   y ${c.wy.toFixed(1)}`, 14, h - 14);
    }
  };

  /** Inch ticks just outside the bottom (x) and left (y) edges: a label every tile, a tick every 6 in. */
  const drawRulers = (ctx: CanvasRenderingContext2D, fx: number, fy: number, fs: number) => {
    const scale = view.current.scale;
    const bottom = fy + fs;
    const marks = Array.from({ length: FIELD_SIZE / 6 + 1 }, (_, i) => i * 6);
    ctx.strokeStyle = C.label;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const m of marks) {
      const major = m % 24 === 0;
      const sx = Math.round(fx + m * scale) + 0.5;
      ctx.moveTo(sx, bottom + 4);
      ctx.lineTo(sx, bottom + (major ? 10 : 7));
      const sy = Math.round(bottom - m * scale) + 0.5;
      ctx.moveTo(fx - 4, sy);
      ctx.lineTo(fx - (major ? 10 : 7), sy);
    }
    ctx.stroke();

    ctx.fillStyle = C.label;
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const m of marks) if (m % 24 === 0) ctx.fillText(String(m), Math.round(fx + m * scale), bottom + 12);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const m of marks) if (m % 24 === 0) ctx.fillText(String(m), fx - 12, Math.round(bottom - m * scale));
  };

  /** ghost = the playing robot; otherwise a start footprint (solid when the pose is set there) */
  const drawRobot = (ctx: CanvasRenderingContext2D, x: number, y: number, thetaDeg: number, ghost: boolean, reset = false) => {
    const v = view.current;
    const [sx, sy] = toScreen(x, y);
    const { robot } = latest.current;
    const L = robot.length * v.scale;
    const W = robot.width * v.scale;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate((thetaDeg * Math.PI) / 180);
    ctx.lineWidth = 1.25;
    if (ghost) {
      ctx.fillStyle = C.ghostFill;
      ctx.strokeStyle = C.fg;
      ctx.fillRect(-L / 2, -W / 2, L, W);
    } else {
      ctx.strokeStyle = reset ? C.startReset : C.start;
      if (!reset) ctx.setLineDash([3, 3]);
    }
    ctx.strokeRect(-L / 2, -W / 2, L, W);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(L / 2, 0);
    ctx.stroke();
    ctx.restore();
  };

  /** The auton's paths: every step in the auton view (the hovered one bright), faint context while editing one. */
  const drawSteps = (ctx: CanvasRenderingContext2D, steps: StepPath[]) => {
    const { activeStep, hoverStep, path } = latest.current;
    const autonView = !path;
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (autonView && steps[0]?.def.points.length) {
      const p0 = steps[0].def.points[0];
      drawRobot(ctx, p0.x, p0.y, p0.theta ?? 0, false, true);
    }
    for (const s of steps) {
      if (s.step === activeStep) continue;
      const pts = s.def.points;
      if (!pts.length) continue;
      const hot = s.step === hoverStep;
      ctx.strokeStyle = autonView ? (hot ? C.fg : C.muted) : hot ? C.contextHot : C.context;
      ctx.lineWidth = autonView ? (hot ? 2.25 : 1.5) : 1.25;
      if (!autonView) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [sx, sy] = toScreen(p.x, p.y);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      if (!autonView) continue;
      // the points, small, then the step's number at its start
      ctx.fillStyle = C.bg;
      for (let i = 1; i < pts.length; i++) {
        const [sx, sy] = toScreen(pts[i].x, pts[i].y);
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (pts[i].theta != null) {
          const [dx, dy] = dir(pts[i].theta!);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + dx * 12, sy + dy * 12);
          ctx.stroke();
        }
      }
      const [bx, by] = toScreen(pts[0].x, pts[0].y);
      ctx.fillStyle = hot ? C.fg : C.muted;
      ctx.beginPath();
      ctx.arc(bx, by, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.bg;
      ctx.fillText(String(s.step + 1), bx, by + 0.5);
    }
  };

  /** The plain ghost trail: dashed, under the path line, so corner cutting shows where the two split. */
  const drawGhostTrail = (ctx: CanvasRenderingContext2D, poses: GhostPose[]) => {
    ctx.strokeStyle = C.ghostTrail;
    ctx.lineWidth = 1.75;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    poses.forEach((p, i) => {
      const [sx, sy] = toScreen(p.x, p.y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };

  /**
   * The speed trail: a solid line, each stretch colored by how fast the ghost drives there (0 to the robot's top
   * speed), with a thin outline in the background color so it reads on the field. Runs of one color are stroked
   * together. Also notes the trail spot under the cursor, for the speed tooltip.
   */
  const drawSpeedTrail = (ctx: CanvasRenderingContext2D, poses: GhostPose[]) => {
    const top = latest.current.robot.maxSpeed;
    const level = (speed: number) => Math.round(Math.min(1, speed / top) * (SPEED_LEVELS - 1));
    const pts = poses.map(p => toScreen(p.x, p.y));

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = C.bg;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    pts.forEach(([sx, sy], i) => (i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy)));
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.lineWidth = 2.5;
    let run = -1;
    for (let i = 1; i < pts.length; i++) {
      const lv = level(poses[i].speed);
      if (lv !== run) {
        if (run >= 0) ctx.stroke();
        run = lv;
        ctx.strokeStyle = speedColor(lv / (SPEED_LEVELS - 1), latest.current.theme);
        ctx.beginPath();
        ctx.moveTo(pts[i - 1][0], pts[i - 1][1]);
      }
      ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    const c = cursor.current;
    if (!c || drag.current) return;
    let best = -1;
    let bestD = HIT_TRAIL;
    pts.forEach(([sx, sy], i) => {
      const d = Math.hypot(c.sx - sx, c.sy - sy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) hoveredTrail.current = { speed: poses[best].speed, t: poses[best].t, sx: pts[best][0], sy: pts[best][1] };
  };

  const drawGhost = (ctx: CanvasRenderingContext2D, playback: Playback) => {
    const poses = playback.ghost.poses;
    if (poses.length > 1) {
      if (latest.current.speedColors) drawSpeedTrail(ctx, poses);
      else drawGhostTrail(ctx, poses);
    }
    if (playback.state !== 'stopped') {
      const pose = poseAt(playback.ghost, playback.timeRef.current);
      if (pose) drawRobot(ctx, pose.x, pose.y, pose.theta, true);
    }
  };

  /** Top-right key for the trail colors: the ramp from stopped to the robot's top speed. */
  const drawSpeedLegend = (ctx: CanvasRenderingContext2D) => {
    const { w } = size.current;
    const top = latest.current.robot.maxSpeed;
    const barW = 72;
    const barH = 6;
    ctx.font = '10px Inter, system-ui, sans-serif';
    const right = `${Math.round(top)} in/s`;
    const rw = ctx.measureText(right).width;
    const lw = ctx.measureText('Speed').width;
    const zw = ctx.measureText('0').width;
    const boxW = 10 + lw + 8 + zw + 6 + barW + 6 + rw + 10;
    const bx = w - 14 - boxW;
    const by = 8;
    ctx.fillStyle = C.bg;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, 20, 5);
    ctx.fill();
    ctx.globalAlpha = 1;

    let x = bx + 10;
    const mid = by + 10.5;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.label;
    ctx.fillText('Speed', x, mid);
    x += lw + 8;
    ctx.fillText('0', x, mid);
    x += zw + 6;
    const grad = ctx.createLinearGradient(x, 0, x + barW, 0);
    const stops = speedStops(latest.current.theme);
    stops.forEach((hex, i) => grad.addColorStop(i / (stops.length - 1), hex));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, mid - barH / 2, barW, barH, 3);
    ctx.fill();
    x += barW + 6;
    ctx.fillStyle = C.label;
    ctx.fillText(right, x, mid);
  };

  /** A curved arrow around a point that turns (or donuts, dashed) to its heading after arriving. */
  const drawTurnMark = (ctx: CanvasRenderingContext2D, sx: number, sy: number, donut: boolean, color: string) => {
    const r = 11;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    if (donut) ctx.setLineDash([2.5, 2.5]);
    ctx.beginPath();
    ctx.arc(sx, sy, r, -Math.PI * 0.95, Math.PI * 0.45);
    ctx.stroke();
    ctx.setLineDash([]);
    const a = Math.PI * 0.45;
    const ex = sx + Math.cos(a) * r;
    const ey = sy + Math.sin(a) * r;
    ctx.beginPath();
    ctx.moveTo(ex - 3.5, ey - 1);
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex + 1.2, ey - 3.6);
    ctx.stroke();
  };

  const drawPath = (ctx: CanvasRenderingContext2D, path: PathDefinition, selection: number[], hoverIndex: number | null) => {
    const pts = path.points;
    const v = view.current;
    if (pts.length === 0) return;
    const { activeStep, timeouts } = latest.current;

    // start footprint: solid where the pose is set (a path of its own, the auton's first step, or reset pose)
    drawRobot(ctx, pts[0].x, pts[0].y, pts[0].theta ?? 0, false, activeStep == null || activeStep === 0 || !!path.resetPose);

    if (pts.length > 1) {
      ctx.strokeStyle = C.path;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [sx, sy] = toScreen(p.x, p.y);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    }

    // early exit rings (the last point always has to arrive, so none there); "R" on moves driven backwards
    ctx.font = '600 9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 1; i < pts.length; i++) {
      const r = resolveParams(path.params, pts[i].params);
      const [sx, sy] = toScreen(pts[i].x, pts[i].y);
      if (i < pts.length - 1 && r.earlyExitRange > 0) {
        ctx.strokeStyle = selection.includes(i) ? C.ringSelected : C.ring;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(sx, sy, r.earlyExitRange * v.scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (r.reverse) {
        const [ax, ay] = toScreen(pts[i - 1].x, pts[i - 1].y);
        const mx = (ax + sx) / 2;
        const my = (ay + sy) / 2;
        ctx.fillStyle = C.fg;
        ctx.beginPath();
        ctx.roundRect(mx - 6, my - 6, 12, 12, 3);
        ctx.fill();
        ctx.fillStyle = C.bg;
        ctx.fillText('R', mx, my + 0.5);
      }
    }

    // points (selected drawn last so they're on top)
    const order = [...pts.map((_, i) => i).filter(i => !selection.includes(i)), ...selection.filter(i => i < pts.length)];
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const i of order) {
      const p = pts[i];
      const [sx, sy] = toScreen(p.x, p.y);
      const sel = selection.includes(i);
      const hov = i === hoverIndex;

      if (sel || hov) {
        ctx.fillStyle = sel ? C.haloSelected : C.halo;
        ctx.beginPath();
        ctx.arc(sx, sy, 11, 0, Math.PI * 2);
        ctx.fill();
      }

      if (p.theta != null) {
        const [dx, dy] = dir(p.theta);
        const tx = sx + dx * HEADING_LEN;
        const ty = sy + dy * HEADING_LEN;
        ctx.strokeStyle = sel ? C.fg : C.muted;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.fillStyle = sel ? C.fg : C.bg;
        ctx.beginPath();
        ctx.arc(tx, ty, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (i > 0 && (p.action === 'turn' || p.action === 'donut')) drawTurnMark(ctx, sx, sy, p.action === 'donut', sel ? C.fg : C.muted);
      }

      const radius = p.theta != null ? R_POINT : R_TRANS;
      ctx.fillStyle = sel ? C.fg : C.bg;
      ctx.strokeStyle = sel ? C.fg : p.theta != null ? C.fg : C.muted;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (timeouts.includes(i)) {
        ctx.strokeStyle = C.fg;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(sx, sy, 15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = sel ? C.fg : C.label;
      ctx.fillText(String(i), sx + 9, sy + 10);
    }
  };

  /** A small label above a spot on the field. */
  const drawTip = (ctx: CanvasRenderingContext2D, text: string, sx: number, sy: number) => {
    ctx.font = '11px Inter, system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    const bx = sx - tw / 2 - 7;
    const by = sy - 30;
    ctx.fillStyle = C.fg;
    ctx.beginPath();
    ctx.roundRect(bx, by, tw + 14, 20, 5);
    ctx.fill();
    ctx.fillStyle = C.bg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, sx, by + 10.5);
  };

  /** The ghost's speed at the trail spot under the cursor (not over a point). */
  const drawTooltips = (ctx: CanvasRenderingContext2D) => {
    const ht = hoveredTrail.current;
    const c = cursor.current;
    if (!ht || !c || hitTest(c.sx, c.sy)) return;
    ctx.fillStyle = speedColor(ht.speed / latest.current.robot.maxSpeed, latest.current.theme);
    ctx.strokeStyle = C.bg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ht.sx, ht.sy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    drawTip(ctx, `${Math.round(ht.speed)} in/s · ${ht.t.toFixed(2)} s`, ht.sx, ht.sy);
  };

  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (dirty.current || latest.current.playback.state === 'playing') {
        dirty.current = false;
        drawRef.current();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- input ----
  const setCursor = (c: string) => {
    if (canvasRef.current) canvasRef.current.style.cursor = c;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { sx, sy } = local(e);
    const w = toWorld(sx, sy);
    const { path, selectedIndex, selection, onSelect, update } = latest.current;
    canvasRef.current!.setPointerCapture(e.pointerId);

    // right or middle drag always pans
    if (e.button === 1 || e.button === 2) {
      drag.current = { kind: 'pan', x: sx, y: sy, moved: false, deselect: false, pick: null };
      return;
    }
    if (e.button !== 0) return;

    const hit = path ? hitTest(sx, sy) : null;
    if (path && hit) {
      if (e.shiftKey) {
        update(removePoint(path, hit.index));
        // a group (selectedIndex null) is dropped; a single selection keeps pointing at the same point
        if (selectedIndex == null || selectedIndex === hit.index) onSelect(null);
        else if (selectedIndex > hit.index) onSelect(selectedIndex - 1);
        return;
      }
      // grabbing a selected group by one of its points: move them all together
      if (hit.mode === 'position' && selection.length > 1 && selection.includes(hit.index)) {
        const start = selection.filter(i => i < path.points.length).map(i => ({ i, x: path.points[i].x, y: path.points[i].y }));
        drag.current = { kind: 'group', wx: w.x, wy: w.y, start, clicked: hit.index, moved: false };
        setCursor('grabbing');
        return;
      }
      // another point, or any point's heading handle: back to just that point
      onSelect(hit.index);
      drag.current = { kind: 'point', index: hit.index, mode: hit.mode, moved: false };
      setCursor('grabbing');
      return;
    }

    // empty field: Shift + drag box-selects, a plain drag pans, a click on another path of the auton opens it
    drag.current = e.shiftKey && path
      ? { kind: 'box', x0: sx, y0: sy, x1: sx, y1: sy, moved: false }
      : { kind: 'pan', x: sx, y: sy, moved: false, deselect: true, pick: stepHit(sx, sy) };
  };

  // Double click on empty field: insert on the nearest segment, otherwise append.
  const onDoubleClick = (e: React.MouseEvent) => {
    const { sx, sy } = local(e);
    const { path, update, onSelect } = latest.current;
    if (!path || e.button !== 0 || hitTest(sx, sy)) return;
    const w = toWorld(sx, sy);
    const pts = path.points;
    let at = pts.length;
    let best = HIT_POINT * 1.5;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = toScreen(pts[i].x, pts[i].y);
      const [bx, by] = toScreen(pts[i + 1].x, pts[i + 1].y);
      const d = distToSegment(sx, sy, ax, ay, bx, by);
      if (d < best) {
        best = d;
        at = i + 1;
      }
    }
    update(insertPoint(path, at, { ...clampToField(w.x, w.y), theta: pts.length === 0 ? 0 : null }));
    onSelect(at);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { sx, sy } = local(e);
    const w = toWorld(sx, sy);
    cursor.current = { sx, sy, wx: w.x, wy: w.y };
    dirty.current = true;
    const d = drag.current;
    const { path, update, checkpoint, onHover, hoverIndex, hoverStep, onHoverStep } = latest.current;

    if (!d) {
      const hit = path ? hitTest(sx, sy) : null;
      const idx = hit?.index ?? null;
      if (idx !== hoverIndex) onHover(idx);
      const step = hit ? null : stepHit(sx, sy);
      if (step !== hoverStep) onHoverStep(step);
      setCursor(hit ? 'grab' : step != null ? 'pointer' : 'default');
      return;
    }

    if (d.kind === 'box') {
      d.x1 = sx;
      d.y1 = sy;
      if (!d.moved && Math.hypot(sx - d.x0, sy - d.y0) >= 3) d.moved = true;
      return;
    }

    if (d.kind === 'group' && path) {
      const dx = w.x - d.wx;
      const dy = w.y - d.wy;
      if (!d.moved) {
        if (Math.hypot(dx, dy) * view.current.scale < 3) return;
        checkpoint();
        d.moved = true;
      }
      update(offsetPoints(path, d.start, dx, dy), false);
      return;
    }

    if (d.kind === 'pan') {
      const dx = sx - d.x;
      const dy = sy - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      d.moved = true;
      view.current.ox += dx;
      view.current.oy += dy;
      d.x = sx;
      d.y = sy;
      fitted.current = false;
      setCursor('grabbing');
      return;
    }

    if (d.kind === 'point' && path) {
      const p = path.points[d.index];
      if (!p) return;
      if (!d.moved) {
        checkpoint();
        d.moved = true;
      }
      if (d.mode === 'position') {
        // Alt snaps to the 6 in grid
        const snap = e.altKey ? (v: number) => Math.round(v / 6) * 6 : round1;
        update(updatePoint(path, d.index, clampToField(w.x, w.y, snap)), false);
      } else {
        // clockwise from +X
        let deg = (Math.atan2(-(w.y - p.y), w.x - p.x) * 180) / Math.PI;
        deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
        update(updatePoint(path, d.index, { theta: wrapDeg(deg) }), false);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    canvasRef.current?.releasePointerCapture(e.pointerId);
    if (!d) return;
    const { path, onSelect, onSelectMany, onPickStep } = latest.current;
    if (d.kind === 'box') {
      if (!d.moved) {
        onSelect(null); // a click on empty field clears the selection
      } else {
        const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
        const [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
        const inside = (path?.points ?? []).flatMap((p, i) => {
          const [px, py] = toScreen(p.x, p.y);
          return px >= x0 && px <= x1 && py >= y0 && py <= y1 ? [i] : [];
        });
        onSelectMany(inside);
      }
      dirty.current = true; // take the box off the screen
    }
    if (d.kind === 'pan' && !d.moved) {
      if (d.pick != null) onPickStep(d.pick);
      else if (d.deselect) onSelect(null); // a click on empty field clears the selection
    }
    if (d.kind === 'group' && !d.moved) onSelect(d.clicked);
    setCursor('default');
  };

  const onPointerLeave = () => {
    cursor.current = null;
    if (latest.current.hoverIndex != null && !drag.current) latest.current.onHover(null);
    if (latest.current.hoverStep != null && !drag.current) latest.current.onHoverStep(null);
    dirty.current = true;
  };

  const onWheel = (e: React.WheelEvent) => {
    const { sx, sy } = local(e);
    const { path, selectedIndex, update } = latest.current;

    // scroll over the selected heading point = rotate it (down turns clockwise)
    const p = selectedIndex != null ? path?.points[selectedIndex] : null;
    if (path && p && p.theta != null) {
      const [px, py] = toScreen(p.x, p.y);
      if (Math.hypot(sx - px, sy - py) < HEADING_LEN + 6) {
        const delta = e.deltaY > 0 ? 5 : -5;
        update(updatePoint(path, selectedIndex!, { theta: wrapDeg(p.theta + delta) }), `wheel-${selectedIndex}`);
        return;
      }
    }

    const v = view.current;
    const w = toWorld(sx, sy);
    const minScale = Math.min(size.current.w, size.current.h) / FIELD_SIZE * 0.4;
    const scale = Math.max(minScale, Math.min(60, v.scale * Math.exp(-e.deltaY * 0.0015)));
    view.current = { scale, ox: sx - w.x * scale, oy: sy + w.y * scale };
    fitted.current = false;
    dirty.current = true;
  };

  const showHint = !props.path && props.steps.every(s => !s.def.points.length);

  return (
    <div className="canvas-wrap" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={e => e.preventDefault()}
      />
      {showHint && <div className="canvas-hint">{props.emptyHint}</div>}
    </div>
  );
}
