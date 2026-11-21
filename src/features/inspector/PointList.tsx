import { useEffect, useRef, useState } from 'react';
import type { PathDefinition } from '../../editor/types';
import { actionOf, resolveParams } from '../../editor/pathOps';
import { targetById } from '../../editor/targets';
import { HeadingGlyph, IconButton } from '../../components/Icon';

interface Props {
  path: PathDefinition;
  selectedIndex: number | null;
  /** every selected point (a box-selected group highlights all its rows) */
  selection: number[];
  hoverIndex: number | null;
  onSelect: (i: number | null) => void;
  onHover: (i: number | null) => void;
  onAdd: () => void;
  onMove: (from: number, to: number) => void;
  timeouts: number[];
}

/** What a point makes in code, for the row's tag. */
const callOf = (p: PathDefinition['points'][number], i: number) => {
  if (i === 0) return 'start';
  return actionOf(p) ?? 'point';
};

/**
 * Every point in order, so overlapping points on the field are still reachable. Drag rows to reorder.
 * Clicking a row selects just that point.
 */
export function PointList({ path, selectedIndex, selection, hoverIndex, onSelect, onHover, onAdd, onMove, timeouts }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => {
    if (selectedIndex == null) return;
    listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const endDrag = () => {
    setDragFrom(null);
    setDropAt(null);
  };

  return (
    <>
      <div className="section-head">
        <span>Points <b className="count">{path.points.length}</b></span>
        <IconButton icon="plus" title="Add point" onClick={onAdd} />
      </div>
      <div className="list scroll points" ref={listRef} onMouseLeave={() => onHover(null)}>
        {path.points.map((p, i) => {
          const call = callOf(p, i);
          const r = resolveParams(path.params, p.params);
          const reverse = i > 0 && r.reverse;
          const spot = targetById(p.target);
          return (
            <div
              key={i}
              data-index={i}
              draggable
              className={[
                'list-row point-row',
                selection.includes(i) && 'selected',
                i === hoverIndex && 'hovered',
                dropAt === i && dragFrom !== null && (dragFrom > i ? 'drop-above' : 'drop-below'),
              ].filter(Boolean).join(' ')}
              onClick={() => onSelect(i === selectedIndex ? null : i)}
              onMouseEnter={() => onHover(i)}
              onDragStart={e => {
                e.dataTransfer.effectAllowed = 'move';
                setDragFrom(i);
              }}
              onDragOver={e => {
                if (dragFrom === null) return;
                e.preventDefault();
                setDropAt(i);
              }}
              onDrop={e => {
                e.preventDefault();
                if (dragFrom !== null && dragFrom !== i) onMove(dragFrom, i);
                endDrag();
              }}
              onDragEnd={endDrag}
            >
              <span className={`idx ${spot ? 'snapped-idx' : ''}`} title={spot?.label}>{i}</span>
              <span className="num">{p.x.toFixed(1)}</span>
              <span className="num">{p.y.toFixed(1)}</span>
              <span className="heading" title={p.theta != null ? `${p.theta}°` : 'No heading'}>
                {p.theta != null ? <><HeadingGlyph theta={p.theta} /><span className="num">{Math.round(p.theta)}°</span></> : <span className="ring" />}
              </span>
              <span className="flags">
                {timeouts.includes(i)
                  ? <span className="warn-dot" title="This move times out in the ghost" />
                  : <span className={`call ${call}`}
                    title={[spot && (spot.kind === 'goal' ? `At ${spot.label}` : `Claw on ${spot.label}`), reverse && 'Driven backwards',
                      r.slowdown > 0 && `Slows down for the last ${Math.round(r.slowdown * 100)}%`].filter(Boolean).join('. ') || undefined}>
                    {call}{reverse ? ' R' : ''}{r.slowdown > 0 ? ' ▾' : ''}
                  </span>}
              </span>
            </div>
          );
        })}
        {path.points.length === 0 && <div className="empty">Double-click the field to add points</div>}
      </div>
    </>
  );
}
