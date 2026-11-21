import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, IconButton, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  hint?: string;
  title?: string;
  checked?: boolean;
  onSelect: () => void;
}

interface Props {
  icon: IconName;
  title: string;
  /** what's listed; a null entry is a separator */
  items: (MenuItem | null)[];
  /** shown when there's nothing to list */
  empty?: ReactNode;
  /** open upward (for buttons near the bottom of the window) */
  up?: boolean;
}

/** An icon button that opens a small menu under (or over) it. */
export function MenuButton({ icon, title, items, empty, up }: Props) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="menu-anchor" ref={anchor} onClick={e => e.stopPropagation()}>
      <IconButton icon={icon} title={title} active={open} expanded={open} onClick={() => setOpen(!open)} />
      {open && (
        <div className={`menu ${up ? '' : 'down'}`} role="menu">
          {items.length === 0 && <div className="menu-empty">{empty}</div>}
          {items.map((item, k) => item == null ? <div key={k} className="menu-sep" /> : (
            <button key={k} type="button" role="menuitem" className="menu-item" title={item.title}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}>
              <span className="menu-check">{item.checked && <Icon name="check" size={14} />}</span>
              <span className="ellipsis">{item.label}</span>
              {item.hint && <span className="menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
