import { useEffect, useRef } from 'react';
import type { Playback } from '../../hooks/usePlayback';
import { Icon, IconButton } from '../../components/Icon';

interface Props {
  playback: Playback;
  /** seconds the auton has (15, or 60 for skills) */
  limit: number;
  /** moves that hit their timeout in the ghost */
  timeouts: number;
  dirty: boolean;
  /** a path is open (not the auton view), so points can be added and the path turned */
  editing: boolean;
  onAdd: () => void;
  onRotate: () => void;
  onFit: () => void;
  onSave: () => void;
}

/** The playhead's time, following playback without re-rendering React every frame. */
function Now({ playback }: { playback: Playback }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { timeRef, ghost } = playback;
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (ref.current) ref.current.textContent = Math.min(timeRef.current, ghost.duration).toFixed(1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [timeRef, ghost]);
  return <span ref={ref} className="now">0.0</span>;
}

function Scrubber({ playback }: { playback: Playback }) {
  const fillRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const { ghost, timeRef, seek } = playback;

  // follow the playhead without re-rendering React every frame
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const f = ghost.duration > 0 ? timeRef.current / ghost.duration : 0;
      if (fillRef.current) fillRef.current.style.width = `${Math.min(1, f) * 100}%`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ghost, timeRef]);

  const seekTo = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    seek(((clientX - r.left) / r.width) * ghost.duration);
  };

  return (
    <div className="scrubber" ref={barRef}
      onPointerDown={e => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekTo(e.clientX);
      }}
      onPointerMove={e => {
        if (e.buttons & 1) seekTo(e.clientX);
      }}>
      <div className="scrubber-track"><div className="scrubber-fill" ref={fillRef} /></div>
    </div>
  );
}

export function Toolbar({ playback, limit, timeouts, dirty, editing, onAdd, onRotate, onFit, onSave }: Props) {
  const { ghost, state } = playback;
  const over = ghost.duration > limit;
  const warn = over || timeouts > 0;
  const title = [
    `Ghost time (${limit} s limit)`,
    over && `${(ghost.duration - limit).toFixed(1)} s over the limit`,
    timeouts > 0 && `${timeouts} move${timeouts > 1 ? 's' : ''} timed out (dashed ring on the point)`,
  ].filter(Boolean).join('\n');

  return (
    <div className="toolbar">
      <IconButton icon={state === 'playing' ? 'pause' : 'play'} title="Play ghost (Space)" onClick={playback.playPause}
        disabled={ghost.poses.length < 2} />
      <IconButton icon="stop" title="Stop" onClick={playback.stop} disabled={state === 'stopped'} />
      <Scrubber playback={playback} />
      <span className={`time ${warn ? 'warn' : ''}`} title={title}>
        {warn && <Icon name="warn" size={13} />}
        <Now playback={playback} />
        <span className="of">/</span>
        {`${ghost.duration.toFixed(1)}s`}
      </span>
      <span className="sep" />
      {editing && (
        <>
          <IconButton icon="plus" title="Add point" onClick={onAdd} />
          <IconButton icon="rotate" title="Turn the path 180° about the field centre (every auton using it changes)" onClick={onRotate} />
        </>
      )}
      <IconButton icon="fit" title="Fit field (F)" onClick={onFit} />
      <span className="sep" />
      <IconButton icon="save" title={dirty ? 'Save now (Ctrl+S). Changes also save on their own.' : 'Saved'} onClick={onSave}
        disabled={!dirty} active={dirty} />
    </div>
  );
}
