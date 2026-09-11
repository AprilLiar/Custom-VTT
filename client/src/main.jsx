import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { initTheme } from './lib/theme.js';
// Imported for its side effects, next to initTheme and for the same reason:
// the audio engine is a module singleton that owns a YouTube iframe outside
// the component tree, so that crossing the /scene route boundary (a separate
// return branch in App.jsx's Shell) can never unmount it and kill the music.
import './lib/audioEngine.js';
import './index.css';

initTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);

// Mobile readiness (Change 002) §14.9A: installable PWA. Registered after
// load so it never competes with the initial render for bandwidth/CPU.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  });
}
