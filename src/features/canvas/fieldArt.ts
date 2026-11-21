import type { Vec2 } from '../../core/geometry';
import { DEFAULT_FIELD } from '../../field';
import type { FieldDefinition } from '../../field/types';
import { FIELD_SIZE } from '../../editor/types';
import type { Theme } from '../../hooks/useTheme';

/**
 * The Override field drawn on the canvas in Crimson's frame. src/field keeps it the way the manual draws it (origin at
 * the centre, red on the left); Crimson's frame is that turned 180 degrees with the origin in blue's right corner,
 * so blue is on the left here, like the FRC field.
 */
const HALF = FIELD_SIZE / 2;
const toCrimson = (p: Vec2): Vec2 => ({ x: HALF - p.x, y: HALF - p.y });

const COLORS = {
  night: {
    tile: '#0b0b0b',
    seam: 'rgba(255,255,255,0.075)',
    tape: 'rgba(255,255,255,0.3)',
    wall: 'rgba(255,255,255,0.8)',
    red: '#e5484d',
    blue: '#4a86ff',
    zoneRed: 'rgba(229,72,77,0.11)',
    zoneBlue: 'rgba(74,134,255,0.11)',
    midfield: 'rgba(255,255,255,0.025)',
    goal: '#161616',
    goalEdge: 'rgba(255,255,255,0.6)',
    element: 'rgba(255,255,255,0.22)',
    pin: 'rgba(233,192,70,0.55)',
    label: 'rgba(255,255,255,0.45)',
  },
  day: {
    tile: '#f3f3f3',
    seam: 'rgba(0,0,0,0.08)',
    tape: 'rgba(0,0,0,0.25)',
    wall: 'rgba(0,0,0,0.8)',
    red: '#d93036',
    blue: '#2f6fe0',
    zoneRed: 'rgba(217,48,54,0.09)',
    zoneBlue: 'rgba(47,111,224,0.09)',
    midfield: 'rgba(0,0,0,0.025)',
    goal: '#ffffff',
    goalEdge: 'rgba(0,0,0,0.6)',
    element: 'rgba(0,0,0,0.2)',
    pin: 'rgba(181,137,0,0.6)',
    label: 'rgba(0,0,0,0.45)',
  },
};

type ToScreen = (x: number, y: number) => [number, number];

export function drawField(ctx: CanvasRenderingContext2D, toScreen: ToScreen, scale: number, theme: Theme,
  field: FieldDefinition = DEFAULT_FIELD) {
  const c = COLORS[theme];
  const at = (p: Vec2) => {
    const q = toCrimson(p);
    return toScreen(q.x, q.y);
  };
  const [fx, fy] = toScreen(0, FIELD_SIZE);
  const size = FIELD_SIZE * scale;

  ctx.fillStyle = c.tile;
  ctx.fillRect(fx, fy, size, size);

  // tile seams
  const tile = FIELD_SIZE / field.tiles;
  ctx.strokeStyle = c.seam;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < field.tiles; i++) {
    const v = Math.round(fx + i * tile * scale) + 0.5;
    ctx.moveTo(v, fy);
    ctx.lineTo(v, fy + size);
    const h = Math.round(fy + i * tile * scale) + 0.5;
    ctx.moveTo(fx, h);
    ctx.lineTo(fx + size, h);
  }
  ctx.stroke();

  // load zones and their tape
  for (const zone of field.loadZones) {
    const [ax, ay] = at(zone.min);
    const [bx, by] = at(zone.max);
    ctx.fillStyle = zone.alliance === 'red' ? c.zoneRed : c.zoneBlue;
    ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    ctx.strokeStyle = zone.alliance === 'red' ? c.red : c.blue;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = Math.max(1, 0.8 * scale);
    ctx.beginPath();
    zone.tape.forEach((p, i) => {
      const [sx, sy] = at(p);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (field.midfield.length) {
    ctx.fillStyle = c.midfield;
    ctx.strokeStyle = c.tape;
    ctx.lineWidth = 1;
    ctx.beginPath();
    field.midfield.forEach((p, i) => {
      const [sx, sy] = at(p);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // white tape (doubled where the manual doubles it)
  ctx.strokeStyle = c.tape;
  ctx.lineWidth = Math.max(1, 0.5 * scale);
  for (const line of field.tape) {
    const dx = line.to.x - line.from.x;
    const dy = line.to.y - line.from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    for (const off of line.double ? [-0.8, 0.8] : [0]) {
      const [x1, y1] = at({ x: line.from.x + nx * off, y: line.from.y + ny * off });
      const [x2, y2] = at({ x: line.to.x + nx * off, y: line.to.y + ny * off });
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  // loaders
  for (const l of field.loaders) {
    const [sx, sy] = at(l.position);
    const w = l.width * scale;
    const h = l.height * scale;
    ctx.fillStyle = l.alliance === 'red' ? c.red : c.blue;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.roundRect(sx - w / 2, sy - h / 2, w, h, 0.5 * scale);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // game elements: cups, pins, four-pin crosses
  ctx.lineWidth = Math.max(1, 0.45 * scale);
  for (const e of field.elements) {
    const [sx, sy] = at(e.position);
    if (e.kind === 'four-pin-cross') {
      const arm = 5.2 * scale;
      ctx.strokeStyle = c.element;
      ctx.beginPath();
      ctx.moveTo(sx - arm, sy);
      ctx.lineTo(sx + arm, sy);
      ctx.moveTo(sx, sy - arm);
      ctx.lineTo(sx, sy + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, 1.2 * scale, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    ctx.strokeStyle = c.element;
    ctx.beginPath();
    ctx.arc(sx, sy, 2.3 * scale, 0, Math.PI * 2);
    ctx.stroke();
    if (e.kind !== 'cup') {
      ctx.fillStyle = c.pin;
      ctx.beginPath();
      ctx.arc(sx, sy, 0.9 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // goals: neutral ones with a hexagon, alliance ones with their color
  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const g of field.goals) {
    const [sx, sy] = at(g.position);
    const s = g.size * scale;
    ctx.fillStyle = c.goal;
    ctx.strokeStyle = g.owner === 'neutral' ? c.goalEdge : g.owner === 'red' ? c.red : c.blue;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(sx - s / 2, sy - s / 2, s, s, scale);
    ctx.fill();
    ctx.stroke();
    if (g.owner === 'neutral') {
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        const px = sx + s * 0.3 * Math.cos(a);
        const py = sy + s * 0.3 * Math.sin(a);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(sx, sy, s * 0.24, 0, Math.PI * 2);
      ctx.fill();
    }
    if (scale >= 3) {
      ctx.fillStyle = c.label;
      ctx.fillText(g.label, sx + s * 0.62, sy - s * 0.55);
    }
  }

  // wall and the bars outside it
  ctx.fillStyle = c.wall;
  ctx.globalAlpha = 0.55;
  for (const bar of field.wallBars) {
    const along = bar.length * scale;
    const gap = 0.25 * scale;
    const t = 1.4 * scale;
    // src/field's sides, turned 180 degrees: its top is our bottom and its left our right
    const side = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[bar.side];
    const mid = fx + size / 2;
    const midY = fy + size / 2;
    if (side === 'top') ctx.fillRect(mid - along / 2, fy - gap - t, along, t);
    else if (side === 'bottom') ctx.fillRect(mid - along / 2, fy + size + gap, along, t);
    else if (side === 'left') ctx.fillRect(fx - gap - t, midY - along / 2, t, along);
    else ctx.fillRect(fx + size + gap, midY - along / 2, t, along);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = c.wall;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(fx, fy, size, size);
}

/** Alliance colors, for anything else that marks red or blue. */
export const allianceColor = (theme: Theme, alliance: 'red' | 'blue') => COLORS[theme][alliance];
