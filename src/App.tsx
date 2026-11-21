import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import './vex.css';

import { useLibrary } from './hooks/useLibrary';
import { usePlayback } from './hooks/usePlayback';
import { useTheme } from './hooks/useTheme';
import { Sidebar } from './features/sidebar/Sidebar';
import { FieldCanvas, type StepPath } from './features/canvas/FieldCanvas';
import { Toolbar } from './features/canvas/Toolbar';
import { PointList } from './features/inspector/PointList';
import { Inspector } from './features/inspector/Inspector';
import { AutonPanel } from './features/inspector/AutonPanel';
import { CodeView } from './features/inspector/CodeView';
import { Icon } from './components/Icon';
import { appendPoint, movePoint, removePoints, rotate180, stepView } from './editor/pathOps';
import { autonCode, pathCode, type SimStep } from './editor/codegen';
import { estimatesFor, simulateSteps } from './editor/ghost';
import type { PathDefinition } from './editor/types';

const GRID = 'pw:grid';
const SPEED = 'pw:speedColors';
const TAB = 'pw:tab';
const EMPTY: PathDefinition = { points: [], params: null };

type Tab = 'edit' | 'code';

const readPref = (key: string, on: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === on;
  } catch {
    return fallback;
  }
};

export default function App() {
  const lib = useLibrary();
  const { theme, toggle: toggleTheme } = useTheme();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverStep, setHoverStep] = useState<number | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [grid, setGrid] = useState(() => readPref(GRID, 'on', false));
  const [speedColors, setSpeedColors] = useState(() => readPref(SPEED, 'on', false));
  const [tab, setTab] = useState<Tab>(() => (readPref(TAB, 'code', false) ? 'code' : 'edit'));
  const [naming, setNaming] = useState<{ auton: string | null } | null>(null);
  const toggleGrid = () => setGrid(g => !g);
  const toggleSpeedColors = () => setSpeedColors(s => !s);

  useEffect(() => {
    try {
      localStorage.setItem(GRID, grid ? 'on' : 'off');
      localStorage.setItem(SPEED, speedColors ? 'on' : 'off');
      localStorage.setItem(TAB, tab);
    } catch { /* not important */ }
  }, [grid, speedColors, tab]);

  const {
    focus, paths, currentPath: path, currentPathName, currentAuton, currentAutonName, rotated,
    selection, setSelection, selectedIndex, setSelectedIndex, update,
  } = lib;
  const editing = currentPathName != null && !!paths[currentPathName];
  const activeStep = focus?.kind === 'step' ? focus.step : null;

  // the auton's paths as it drives them
  const steps: StepPath[] = useMemo(
    () => (currentAuton
      ? currentAuton.steps.flatMap((s, k) => (paths[s.path] ? [{ step: k, def: stepView(paths[s.path], s) }] : []))
      : []),
    [currentAuton, paths],
  );

  // the ghost: the whole auton in its view, otherwise the open path on its own
  const autonView = focus?.kind === 'auton' && !!currentAuton;
  const simSteps: SimStep[] = useMemo(() => {
    if (autonView) return currentAuton!.steps.map(s => ({ def: paths[s.path] ?? EMPTY, rotate: s.rotate }));
    return editing ? [{ def: path }] : [];
  }, [autonView, currentAuton, paths, path, editing]);
  const limit = currentAuton?.skills ? 60 : 15;
  const ghost = useMemo(() => simulateSteps(simSteps, lib.robot, limit), [simSteps, lib.robot, limit]);
  const playback = usePlayback(ghost);
  const pointTimeouts = useMemo(() => (autonView ? [] : ghost.timeouts.map(t => t.point)), [ghost, autonView]);
  const stepTimeouts = useMemo(() => (autonView ? [...new Set(ghost.timeouts.map(t => t.step))] : []), [ghost, autonView]);

  // something else opened: fresh ghost, nothing hovered
  const focusKey = JSON.stringify(focus);
  const stopPlayback = useRef(playback.stop);
  stopPlayback.current = playback.stop;
  useEffect(() => {
    stopPlayback.current();
    setHoverIndex(null);
    setHoverStep(null);
  }, [focusKey]);

  const robot = lib.robot;
  const code = useMemo(() => {
    const opts = { clawOffset: robot.clawOffset, estimates: (def: PathDefinition) => estimatesFor(def, robot) };
    if (currentAutonName && currentAuton) return autonCode(currentAutonName, currentAuton, paths, opts);
    if (currentPathName && paths[currentPathName]) return pathCode(currentPathName, paths[currentPathName], opts);
    return '';
  }, [currentAutonName, currentAuton, currentPathName, paths, robot]);
  // the ghost's suggested timeouts for the open path (the same for a turned use)
  const estimates = useMemo(() => estimatesFor(editing ? path : EMPTY, robot), [editing, path, robot]);

  const addPoint = () => {
    if (!editing) return;
    update(appendPoint(path));
    setSelectedIndex(path.points.length);
  };

  /** Delete the selected point, or the whole selected group (one undo step). */
  const deleteSelected = () => {
    if (!editing || selection.length === 0) return;
    update(removePoints(path, selection));
    setSelection([]);
  };

  const reorder = (from: number, to: number) => {
    update(movePoint(path, from, to));
    // keep the same points selected after the shuffle
    const order = path.points.map((_, i) => i);
    const [m] = order.splice(from, 1);
    order.splice(to, 0, m);
    setSelection(selection.map(i => order.indexOf(i)));
  };

  const stepSelection = (dir: 1 | -1) => {
    const n = path.points.length;
    if (!editing || !n) return;
    setSelectedIndex(selectedIndex == null ? (dir > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, selectedIndex + dir)));
  };

  const openStep = (k: number) => {
    if (currentAutonName) lib.setFocus({ kind: 'step', auton: currentAutonName, step: k });
  };

  const setStepRotate = (v: boolean) => {
    if (focus?.kind !== 'step' || !currentAuton) return;
    lib.updateAuton(focus.auton, {
      ...currentAuton,
      steps: currentAuton.steps.map((s, j) => (j === focus.step ? { ...s, rotate: v ? true : undefined } : s)),
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const k = e.key.toLowerCase();

      if (mod && k === 's') {
        e.preventDefault();
        void lib.saveAll();
        return;
      }
      if (typing) return;

      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) lib.redo();
        else lib.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        lib.redo();
      } else if (mod) {
        return;
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelected();
      } else if (e.key === 'Escape') {
        // nothing selected in a step: back to its auton
        if (selection.length === 0 && focus?.kind === 'step') lib.setFocus({ kind: 'auton', auton: focus.auton });
        else setSelectedIndex(null);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        stepSelection(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === ' ') {
        e.preventDefault();
        playback.playPause();
      } else if (k === 'f') {
        setFitToken(t => t + 1);
      } else if (k === 'g') {
        toggleGrid();
      } else if (k === 'v') {
        toggleSpeedColors();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!lib.ready) return <div className="welcome" />;

  const pathDirty = currentPathName != null && lib.dirty.has(`path:${currentPathName}`);
  const autonDirty = currentAutonName != null && lib.dirty.has(`auton:${currentAutonName}`);
  const hint = !focus ? 'Pick or make an auton on the left'
    : focus.kind === 'auton' ? 'Add paths to this auton with + on the right'
      : 'Double-click the field to add points';

  return (
    <div className={`app ${tab === 'code' ? 'code-open' : ''}`}>
      <Sidebar lib={lib} theme={theme} onToggleTheme={toggleTheme} grid={grid} onToggleGrid={toggleGrid}
        speedColors={speedColors} onToggleSpeedColors={toggleSpeedColors}
        onNewPath={auton => setNaming({ auton })} naming={naming} onNamingDone={() => setNaming(null)} />

      <main className="stage">
        <FieldCanvas
          path={editing ? path : null}
          steps={steps}
          activeStep={activeStep}
          hoverStep={hoverStep}
          onHoverStep={setHoverStep}
          onPickStep={openStep}
          selectedIndex={selectedIndex}
          selection={selection}
          hoverIndex={hoverIndex}
          onSelect={setSelectedIndex}
          onSelectMany={setSelection}
          onHover={setHoverIndex}
          update={update}
          checkpoint={lib.checkpoint}
          playback={playback}
          timeouts={pointTimeouts}
          fitToken={fitToken}
          theme={theme}
          robot={lib.robot}
          grid={grid}
          speedColors={speedColors}
          emptyHint={hint}
        />
        {focus && (
          <div className={`crumbs ${focus.kind === 'step' ? 'has-back' : ''}`}>
            {focus.kind === 'step' && (
              <button type="button" className="crumb-back" title="Back to the auton (Esc)"
                onClick={() => lib.setFocus({ kind: 'auton', auton: focus.auton })}>
                <Icon name="chevron" size={12} />
              </button>
            )}
            {currentAutonName ? (
              <button type="button" className={`crumb ${focus.kind === 'auton' ? 'here' : ''}`}
                onClick={() => lib.setFocus({ kind: 'auton', auton: currentAutonName })}>{currentAutonName}</button>
            ) : <span className="crumb">Paths</span>}
            {focus.kind === 'step' && <><span className="crumb-sep">/</span><span className="crumb here">{activeStep! + 1} · {currentPathName}</span></>}
            {focus.kind === 'path' && <><span className="crumb-sep">/</span><span className="crumb here">{currentPathName}</span></>}
            {rotated && <span className="crumb-tag" title="This auton drives the path turned 180°"><Icon name="rotate" size={12} />180°</span>}
          </div>
        )}
        {(editing || autonView) && (
          <Toolbar
            playback={playback}
            limit={limit}
            timeouts={ghost.timeouts.length}
            dirty={lib.dirty.size > 0}
            editing={editing}
            onAdd={addPoint}
            onRotate={() => update(rotate180(path))}
            onFit={() => setFitToken(t => t + 1)}
            onSave={() => void lib.saveAll()}
          />
        )}
      </main>

      <aside className="panel right">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'edit'} className={tab === 'edit' ? 'on' : ''} onClick={() => setTab('edit')}>
            <Icon name={autonView ? 'folder' : 'route'} size={14} />
            {autonView ? 'Auton' : 'Path'}
            {(autonView ? autonDirty : pathDirty) && <span className="dirty-dot" />}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>
            <Icon name="code" size={14} />
            Output code
          </button>
        </div>
        {tab === 'code' ? (
          code ? <CodeView code={code} label={currentAutonName ?? currentPathName ?? ''} /> : <div className="empty pad">Open an auton or a path</div>
        ) : autonView ? (
          <AutonPanel
            name={currentAutonName!}
            auton={currentAuton!}
            paths={paths}
            update={(def, mode) => lib.updateAuton(currentAutonName!, def, mode)}
            onOpenStep={openStep}
            hoverStep={hoverStep}
            onHoverStep={setHoverStep}
            onNewPath={() => setNaming({ auton: currentAutonName })}
            duration={ghost.duration}
            timeoutSteps={stepTimeouts}
          />
        ) : editing ? (
          <>
            <PointList
              path={path}
              selectedIndex={selectedIndex}
              selection={selection}
              hoverIndex={hoverIndex}
              onSelect={setSelectedIndex}
              onHover={setHoverIndex}
              onAdd={addPoint}
              onMove={reorder}
              timeouts={pointTimeouts}
            />
            <Inspector
              path={path}
              name={currentPathName!}
              selectedIndex={selectedIndex}
              selectionCount={selection.length}
              onDeleteSelection={deleteSelected}
              update={update}
              onSelect={setSelectedIndex}
              duration={ghost.duration}
              estimates={estimates}
              auton={focus?.kind === 'step' && currentAutonName
                ? { name: currentAutonName, rotated, first: focus.step === 0, onRotate: setStepRotate }
                : null}
            />
          </>
        ) : (
          <div className="empty pad">Nothing open</div>
        )}
      </aside>
    </div>
  );
}
