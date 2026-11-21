import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  /** which edge of the button the menu lines up with (default right) */
  align?: 'left' | 'right';
  /** a heading at the top of the menu */
  heading?: string;
}

/**
 * An icon button that opens a small menu under (or over) it. The menu is fixed to the window, so a scrolling list
 * it sits in can't clip it; it closes on scroll, Escape, or a click elsewhere.
 */
export function MenuButton({ icon, title, items, empty, up, align = 'right', heading }: Props) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const anchor = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const gap = 6;
    const vertical: CSSProperties = up
      ? { bottom: window.innerHeight - r.top + gap, maxHeight: r.top - gap - 12 }
      : { top: r.bottom + gap, maxHeight: window.innerHeight - r.bottom - gap - 12 };
    const horizontal: CSSProperties = align === 'left' ? { left: r.left } : { right: window.innerWidth - r.right };
    setPlace({ position: 'fixed', ...vertical, ...horizontal });
  }, [open, up, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && anchor.current?.contains(e.target))) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <span className={`menu-anchor ${open ? 'open' : ''}`} ref={anchor} onClick={e => e.stopPropagation()}
      onDragStart={e => e.preventDefault()}>
      <IconButton icon={icon} title={title} active={open} expanded={open} onClick={() => setOpen(!open)} />
      {open && (
        <div className="menu fixed" role="menu" style={place}>
          {heading && <div className="menu-heading">{heading}</div>}
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
