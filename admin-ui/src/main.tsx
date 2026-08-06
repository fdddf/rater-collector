import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * Seed the theme before React paints, so a dark-mode viewer never sees a white flash.
 * An explicit choice is remembered; otherwise the OS setting wins and keeps tracking it.
 */
const stored = localStorage.getItem('rater.theme');
const media = window.matchMedia('(prefers-color-scheme: dark)');
const apply = (dark: boolean) => document.documentElement.classList.toggle('dark', dark);

apply(stored ? stored === 'dark' : media.matches);
media.addEventListener('change', (e) => {
  if (!localStorage.getItem('rater.theme')) apply(e.matches);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
