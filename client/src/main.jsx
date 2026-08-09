import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { initTheme } from './lib/theme.js';
import { initInk } from './lib/inkAssets.js';
import './index.css';

initTheme();
// Publishes the generated ink masks onto :root. Before the first render for
// the same reason initTheme() is: a mask variable that lands after the first
// paint shows up as a visible flash of un-torn, square panels.
initInk();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// Mobile readiness (Change 002) §14.9A: installable PWA. Registered after
// load so it never competes with the initial render for bandwidth/CPU.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  });
}
