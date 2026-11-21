import { afterEach, describe, expect, it } from 'vitest';
import { pathCode, type CodeOptions } from '../src/editor/codegen';
import { rotate180, syncSpots } from '../src/editor/pathOps';
import { currentField, mirrorTarget, setLoaderOffsets, targetById } from '../src/editor/targets';
import type { PathDefinition } from '../src/editor/types';

const opts: CodeOptions = { clawOffset: 6.3, goalOffset: 7.5 };
const path = (points: PathDefinition['points']): PathDefinition => ({ points, params: null });
const round = (v: number) => Math.round(v * 100) / 100;

describe('loader offsets', () => {
  afterEach(() => setLoaderOffsets({}));

  it('moves each loader along its wall, away from the corner', () => {
    setLoaderOffsets({ 'loader-blue-top': 0.5, 'loader-red-bottom': 1 });
    // blue right: 12.5 in from the Y = 0 corner; red right: 13 in from the Y = 144 corner
    expect([targetById('loader-blue-top')!.x, targetById('loader-blue-top')!.y].map(round)).toEqual([2.4, 12.5]);
    expect([targetById('loader-red-bottom')!.x, targetById('loader-red-bottom')!.y].map(round)).toEqual([141.6, 131]);
    // the others stay at 12 in
    expect(round(targetById('loader-red-top')!.y)).toBe(12);
    expect(round(targetById('loader-blue-bottom')!.y)).toBe(132);
    // names and pairing don't change
    expect(targetById('loader-blue-top')!.label).toBe('blue right loader');
    expect(mirrorTarget('loader-blue-top')).toBe('loader-red-bottom');
    // the drawing (the manual's frame: Crimson's turned 180 degrees) moves the same way
    const drawn = currentField().loaders.find(l => l.id === 'loader-blue-top')!;
    expect([72 - drawn.position.x, 72 - drawn.position.y].map(round)).toEqual([2.4, 12.5]);
  });

  it('keeps points on a moved loader, and leaves the rest alone', () => {
    const p = path([{ x: 30, y: 30, theta: 180 }, { x: 2.4, y: 12, target: 'loader-blue-top' }]);
    expect(syncSpots(p)).toBe(p);
    setLoaderOffsets({ 'loader-blue-top': -0.75 });
    const synced = syncSpots(p);
    expect(synced.points[1]).toMatchObject({ x: 2.4, y: 11.25, target: 'loader-blue-top' });
    expect(synced.points[0]).toBe(p.points[0]);
    expect(pathCode('p', synced, opts)).toContain('// claw on blue right loader (2.4, 11.3)');
  });

  it('puts a turned point on the twin loader where this field has it', () => {
    setLoaderOffsets({ 'loader-blue-top': 0.5, 'loader-red-bottom': 1 });
    const p = path([{ x: 30, y: 30, theta: 180 }, { x: 2.4, y: 12.5, target: 'loader-blue-top' }]);
    const turned = rotate180(p);
    expect(turned.points[1].target).toBe('loader-red-bottom');
    expect([turned.points[1].x, turned.points[1].y].map(round)).toEqual([141.6, 131]);
    expect(rotate180(turned)).toEqual(p);
  });
});
