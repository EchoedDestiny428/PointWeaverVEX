import { useEffect, useState } from 'react';
import { store } from '../editor/store';

export type Theme = 'night' | 'day';

const KEY = 'pw:theme';

const initial = (): Theme => {
  try {
    return localStorage.getItem(KEY) === 'day' ? 'day' : 'night';
  } catch {
    return 'night';
  }
};

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store.setTheme(theme === 'day' ? 'light' : 'dark'); // the window frame follows
    try {
      localStorage.setItem(KEY, theme);
    } catch { /* not important */ }
  }, [theme]);

  return { theme, toggle: () => setTheme(t => (t === 'day' ? 'night' : 'day')) };
}
