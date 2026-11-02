import React from 'react';
import ReactDOM from 'react-dom/client';
import './lib/socket'; 
import App from './App';
import 'leaflet/dist/leaflet.css';
import './index.css';

// 🏷️ Marca de compilación: permite saber desde la consola del móvil qué
// bundle está cargado (útil cuando un dispositivo conserva una versión vieja).
console.log("🚀 VallesViaje client build:", "posicion-taxi-2026-11-02");

// 🚀 Registro directo y temprano del Service Worker (Optimizado para Producción)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then(reg => {
      console.log('✅ SW registrado desde main.tsx:', reg.scope);
      reg.update().catch(() => {});
    })
    .catch(err => console.error('❌ Error registrando SW:', err));
}

// Mantenemos el StrictMode si quieres para desarrollo, sabiendo que en el build final no duplicará nada
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);