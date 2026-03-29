import React from 'react';
import ReactDOM from 'react-dom/client';
import './lib/socket'; 
import App from './App';
import 'leaflet/dist/leaflet.css';
import './index.css';

// 🚀 Registro temprano del Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('✅ SW registrado desde main.tsx:', reg.scope))
      .catch(err => console.error('❌ Error registrando SW:', err));
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);