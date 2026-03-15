import React, { useState, useCallback, useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { pasajeroIcon, taxistaIcon } from "../utils/icons";
import { socket } from "../lib/socket";
import { useSocketPayload } from "../hooks/useSocketPayload";
import { Car, User, Bell, Radio } from "lucide-react";
import DispatchControl from "../components/DispatchControl";

// 🛡️ Validador de coordenadas
const esPosicionValida = (lat?: number | null, lng?: number | null) => {
  return lat != null && lng != null && lat !== 0 && lng !== 0;
};

// 🎥 Componente para mover la cámara del mapa
const ChangeView = ({ center }: { center: [number, number] }) => {
  const map = useMap();
  useEffect(() => {
    if (center[0] !== 0) map.setView(center, 15);
  }, [center, map]);
  return null;
};

// Ponla antes del componente PanelCentral
const getDistanceKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371; 
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const PanelCentral: React.FC = () => {
  const { positions } = useSocketPayload();
  const [pasajeroSeleccionadoEmail, setPasajeroSeleccionadoEmail] = useState<string | null>(null);

  const CENTER_VALLES: [number, number] = [21.9850, -99.0150];

  // --- FILTROS DE POSICIONES ---
  const posicionesValidas = useMemo(() => 
    positions.filter(p => esPosicionValida(p.lat, p.lng)), 
    [positions]
  );

  const pasajerosEspera = useMemo(() => 
    posicionesValidas.filter(u => 
      u.role === "pasajero" && ["activo", "esperando", "solicitando", "pendiente"].includes(u.estado.toLowerCase())
    ),
    [posicionesValidas]
  );

 const viajesEnCurso = useMemo(() =>
  posicionesValidas
    .filter(u => u.role === "pasajero" && ["asignado", "en camino", "aceptado", "viajando", "en curso", "ocupado"].includes(u.estado.toLowerCase()))
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()), // 🕒 Los más recientes arriba
  [posicionesValidas]
);

  const taxistasOnline = useMemo(() => 
    posicionesValidas.filter(u => u.role === "taxista" && u.estado.toLowerCase() !== "desconectado"),
    [posicionesValidas]
  );

  // Objeto del pasajero actualmente seleccionado
  const pasajeroSeleccionado = useMemo(() => 
    posicionesValidas.find(p => p.email === pasajeroSeleccionadoEmail), 
    [posicionesValidas, pasajeroSeleccionadoEmail]
  );

  // 🎯 Obtener los 3 taxistas más cercanos al pasajero seleccionado
const taxistasCercanos = useMemo(() => {
  if (!pasajeroSeleccionado || !pasajeroSeleccionado.lat || !pasajeroSeleccionado.lng) return [];

  return [...taxistasOnline]
    .filter(t => t.estado.toLowerCase() === "activo") // Solo los que pueden atender
    .sort((a, b) => {
      const distA = getDistanceKm(pasajeroSeleccionado.lat!, pasajeroSeleccionado.lng!, a.lat!, a.lng!);
      const distB = getDistanceKm(pasajeroSeleccionado.lat!, pasajeroSeleccionado.lng!, b.lat!, b.lng!);
      return distA - distB;
    })
    .slice(0, 3); // Solo tomamos los 3 mejores
}, [taxistasOnline, pasajeroSeleccionado]);

  // 🧹 LIMPIADOR: Si el pasajero seleccionado entra en un viaje por modo automático, lo soltamos del panel manual
  useEffect(() => {
    if (pasajeroSeleccionado) {
      const estaOcupado = ["asignado", "en camino", "en curso", "viajando", "aceptado", "ocupado"].includes(pasajeroSeleccionado.estado.toLowerCase());
      if (estaOcupado) {
        setPasajeroSeleccionadoEmail(null);
      }
    }
  }, [pasajeroSeleccionado]);

  // 🧹 Efecto para deseleccionar pasajeros que dejan de estar disponibles
useEffect(() => {
  if (pasajeroSeleccionado) {
    const estadoActual = pasajeroSeleccionado.estado.toLowerCase();
    const yaNoDisponible = ["asignado", "en camino", "en curso", "viajando", "aceptado"].includes(estadoActual);
    
    if (yaNoDisponible) {
      setPasajeroSeleccionadoEmail(null);
    }
  }
}, [pasajeroSeleccionado]);

  // 🚀 ASIGNACIÓN MANUAL
  const ejecutarAsignacionManual = useCallback((emailTaxista: string) => {
    if (!pasajeroSeleccionadoEmail) return;

    socket.emit("admin_assign_taxi", {
      pasajeroEmail: pasajeroSeleccionadoEmail,
      taxistaEmail: emailTaxista
    });

    setPasajeroSeleccionadoEmail(null);
  }, [pasajeroSeleccionadoEmail]);

  return (
    <div className="flex flex-col h-screen w-full bg-slate-100 overflow-hidden font-sans">
      
      {/* 🗺️ MAPA */}
      <div className="h-[50%] w-full relative">
        <MapContainer center={CENTER_VALLES} zoom={14} style={{ height: "100%", width: "100%" }}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          
          {/* Centrar cámara si hay un pasajero seleccionado */}
          {pasajeroSeleccionado && (
            <ChangeView center={[pasajeroSeleccionado.lat!, pasajeroSeleccionado.lng!]} />
          )}

          {posicionesValidas.map((u) => {
            const estaEnViaje = ["asignado", "en camino", "en curso", "viajando", "aceptado", "ocupado"].includes(u.estado.toLowerCase());

            return (
              <Marker 
                key={`${u.email}-${u.estado}`} 
                position={[u.lat!, u.lng!]} 
                icon={u.role === "taxista" ? taxistaIcon : pasajeroIcon}
                eventHandlers={{ 
                  click: () => {
                    // Bloqueo estricto: No seleccionar si ya está en viaje
                    if (u.role === "pasajero" && !estaEnViaje) {
                      setPasajeroSeleccionadoEmail(u.email);
                    } else if (u.role === "pasajero" && estaEnViaje) {
                      setPasajeroSeleccionadoEmail(null);
                    }
                  } 
                }}
              >
                <Popup>
                  <div className="text-center">
                    <b className="text-xs uppercase block border-b mb-1">{u.name}</b>
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${estaEnViaje ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                      {u.estado.toUpperCase()}
                    </span>
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>

      <DispatchControl />

      {/* 📊 SECCIÓN DE GESTIÓN */}
      <div className="flex-1 p-3 grid grid-cols-1 md:grid-cols-3 gap-3 overflow-hidden bg-white">
        
        {/* 1. 🚕 FLOTA DISPONIBLE */}
        <section className="border border-slate-200 rounded-2xl p-3 bg-slate-50 flex flex-col overflow-hidden">
          <header className="flex justify-between items-center mb-2 border-b pb-2">
            <h3 className="text-[10px] font-black text-slate-500 uppercase flex items-center gap-2"><Car size={14}/> Flota Seleccionable</h3>
          </header>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {taxistasOnline.map(t => (
              <button 
                key={t.email} 
                disabled={t.estado.toLowerCase() === 'ocupado' || !pasajeroSeleccionadoEmail}
                onClick={() => ejecutarAsignacionManual(t.email)}
                className={`w-full text-left p-2 rounded-xl border transition-all flex flex-col ${
                  t.estado.toLowerCase() === 'ocupado' 
                    ? "bg-slate-100 opacity-50 grayscale cursor-not-allowed border-slate-200" 
                    : "bg-white border-slate-200 hover:border-green-500 hover:shadow-md active:scale-95"
                }`}
              >
                <div className="flex justify-between items-center w-full">
                  <span className="font-bold text-xs">Unidad: {t.taxiNumber}</span>
                  <span className={`text-[8px] font-black px-1.5 py-0.5 rounded uppercase ${t.estado.toLowerCase() === 'ocupado' ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                    {t.estado}
                  </span>
                </div>
                <p className="text-[10px] text-slate-500 truncate">{t.name}</p>
               {/* Cambia esta línea en tu lista de taxistas */}
{pasajeroSeleccionadoEmail && t.estado.toLowerCase() !== 'ocupado' && (
  <span className="text-[8px] mt-1 text-green-600 font-bold italic animate-pulse">
    {/* Usamos ?. para evitar el error de 'undefined' */}
    ¡Click para asignar a {pasajeroSeleccionado?.name || "pasajero"}!
  </span>
)}
              </button>
            ))}
          </div>
        </section>

        {/* 2. 🧍 PASAJEROS ESPERANDO */}
        <section className="border border-blue-100 rounded-2xl p-3 bg-blue-50/50 flex flex-col overflow-hidden">
          <header className="flex justify-between items-center mb-2 border-b border-blue-100 pb-2">
            <h3 className="text-[10px] font-black text-blue-600 uppercase tracking-widest flex items-center gap-2">
              <Bell size={14} className="animate-pulse"/> Solicitudes Pendientes
            </h3>
          </header>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {pasajerosEspera.map(p => (
              <button
                key={p.email}
                onClick={() => setPasajeroSeleccionadoEmail(p.email)}
                className={`w-full text-left p-3 rounded-xl border transition-all ${
                  pasajeroSeleccionadoEmail === p.email ? "bg-blue-600 border-blue-600 text-white shadow-md scale-[0.98]" : "bg-white border-blue-100 hover:border-blue-400"
                }`}
              >
                <p className="font-bold text-xs">{p.name}</p>
                <p className={`text-[8px] ${pasajeroSeleccionadoEmail === p.email ? "text-blue-100" : "text-slate-400"} italic`}>{p.email}</p>
              </button>
            ))}
          </div>
        </section>

        {/* 3. 📡 TRÁFICO EN CURSO */}
        <section className="border border-slate-200 rounded-2xl p-3 bg-slate-50 flex flex-col overflow-hidden">
          <header className="flex justify-between items-center mb-2 border-b pb-2">
            <h3 className="text-[10px] font-black text-slate-500 uppercase flex items-center gap-2"><Radio size={14}/> Viajes en Curso</h3>
          </header>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {viajesEnCurso.map(v => (
              <div key={v.email} className="bg-white/80 p-2 rounded-xl border border-slate-200 flex items-center gap-3">
                <div className="p-1.5 bg-indigo-50 text-indigo-500 rounded-lg"><User size={14}/></div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-[11px] text-slate-700 truncate">{v.name}</p>
                  <p className="text-[9px] text-indigo-500 font-black uppercase tracking-tighter">{v.estado}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* 🚀 BARRA DE ACCIÓN INFERIOR */}
      <div className={`p-4 bg-white border-t border-slate-200 transition-all duration-500 shadow-[0_-10px_20px_rgba(0,0,0,0.05)] ${pasajeroSeleccionado ? "translate-y-0 opacity-100" : "translate-y-full opacity-0 pointer-events-none"}`}>
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
             <div className="h-10 w-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-600">
                <User size={20} />
             </div>
             <div>
               <p className="text-[10px] font-black text-slate-400 uppercase leading-none mb-1">Pasajero Objetivo:</p>
               <p className="text-lg font-black text-blue-600 leading-none">{pasajeroSeleccionado?.name}</p>
             </div>
          </div>
          <div className="flex gap-3">
             <button
               onClick={() => setPasajeroSeleccionadoEmail(null)}
               className="px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-xl font-bold text-xs transition-colors"
             >
               CANCELAR
             </button>
             <div className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold text-xs animate-pulse flex items-center gap-2">
               <Car size={14} /> SELECCIONA UN TAXISTA PARA ASIGNAR
             </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PanelCentral;