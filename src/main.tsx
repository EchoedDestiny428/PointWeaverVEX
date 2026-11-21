import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// A file dropped anywhere would be opened in place of the app. Places that take drops handle dragover themselves.
window.addEventListener('dragover', e => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', e => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
