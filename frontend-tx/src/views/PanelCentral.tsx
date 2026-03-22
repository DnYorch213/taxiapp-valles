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

const posicionesValidas = useMemo(() => 
  positions.filter(p => 
    esPosicionValida(p.lat, p.lng) && 
    // 🛡️ Filtro doble: Si por alguna razón el objeto sigue ahí pero dice desconectado, no lo pintes
    p.estado.toLowerCase() !== "desconectado"
  ), 
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
  <div className="flex flex-col h-screen w-full bg-white overflow-hidden font-sans">
    
    {/* 🟢 BARRA SUPERIOR INSTITUCIONAL */}
    <header className="bg-[#22c55e] py-2 px-4 flex justify-between items-center shadow-md z-[1001]">
      <h1 className="text-white font-black tracking-tighter text-sm italic uppercase">
        Panel Central <span className="text-white/150">| Ciudad Valles</span>
      </h1>
      <div className="flex items-center gap-4 text-white/80 text-[10px] font-bold uppercase tracking-widest">
        <span>App Oficial</span>
        <div className="h-2 w-2 bg-green-400 rounded-full animate-pulse"></div>
      </div>
    </header>

    {/* 🗺️ MAPA (Con borde sutil) */}
    <div className="h-[45%] w-full relative border-b-4 border-[#22c55e]/10">
      <MapContainer center={CENTER_VALLES} zoom={14} style={{ height: "100%", width: "100%" }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        
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
                  if (u.role === "pasajero" && !estaEnViaje) {
                    setPasajeroSeleccionadoEmail(u.email);
                  } else {
                    setPasajeroSeleccionadoEmail(null);
                  }
                } 
              }}
            >
              <Popup>
                <div className="text-center p-1">
                  <b className="text-[10px] uppercase block border-b mb-1 text-slate-800">{u.name}</b>
                  <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${estaEnViaje ? 'bg-[#22c55e] text-white' : 'bg-slate-100 text-slate-600'}`}>
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

    {/* 📊 SECCIÓN DE GESTIÓN (Colores Valles) */}
    <div className="flex-1 p-3 grid grid-cols-1 md:grid-cols-3 gap-4 overflow-hidden bg-slate-50">
      
      {/* 1. 🚕 FLOTA DISPONIBLE (Verde Bandera) */}
      <section className="border border-slate-200 rounded-[2rem] p-4 bg-white flex flex-col shadow-sm overflow-hidden transition-all">
        <header className="flex justify-between items-center mb-3 border-b border-slate-50 pb-2">
          <h3 className="text-[10px] font-black text-[#22c55e] uppercase flex items-center gap-2">
            <Car size={14}/> Flota de Unidades
          </h3>
        </header>
        <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
          {taxistasOnline.map(t => (
            <button 
              key={t.email} 
              disabled={t.estado.toLowerCase() === 'ocupado' || !pasajeroSeleccionadoEmail}
              onClick={() => ejecutarAsignacionManual(t.email)}
              className={`w-full text-left p-3 rounded-2xl border transition-all flex flex-col relative overflow-hidden ${
                t.estado.toLowerCase() === 'ocupado' 
                  ? "bg-slate-50 opacity-50 grayscale border-slate-100" 
                  : "bg-white border-slate-100 hover:border-[#22c55e] hover:shadow-md active:scale-95"
              }`}
            >
              <div className="flex justify-between items-center w-full mb-1">
                <span className="font-black text-xs text-slate-800 italic">Taxi-{t.taxiNumber}</span>
                <span className={`text-[8px] font-black px-2 py-0.5 rounded-full uppercase ${t.estado.toLowerCase() === 'ocupado' ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'}`}>
                  {t.estado}
                </span>
              </div>
              <p className="text-[10px] text-slate-500 font-bold uppercase truncate tracking-tighter">{t.name}</p>
              
              {pasajeroSeleccionadoEmail && t.estado.toLowerCase() !== 'ocupado' && (
                <div className="mt-2 py-1 bg-[#22c55e] text-white text-[8px] font-black text-center rounded-lg animate-pulse">
                  ASIGNAR A {pasajeroSeleccionado?.name || 'Pasajero'}
                </div>
              )}
            </button>
          ))}
        </div>
      </section>

      {/* 2. 🧍 PASAJEROS ESPERANDO (Enfoque en solicitud) */}
      <section className="border border-[#22c55e]/20 rounded-[2rem] p-4 bg-white flex flex-col shadow-sm overflow-hidden">
        <header className="flex justify-between items-center mb-3 border-b border-[#22c55e]/5 pb-2">
          <h3 className="text-[10px] font-black text-[#22c55e] uppercase tracking-widest flex items-center gap-2">
            <Bell size={14} className="animate-bounce text-[#22c55e]"/> Solicitudes
          </h3>
        </header>
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {pasajerosEspera.map(p => (
            <button
              key={p.email}
              onClick={() => setPasajeroSeleccionadoEmail(p.email)}
              className={`w-full text-left p-4 rounded-2xl border-2 transition-all ${
                pasajeroSeleccionadoEmail === p.email 
                ? "bg-[#22c55e] border-[#22c55e] text-white shadow-lg" 
                : "bg-white border-slate-50 hover:border-[#22c55e]/30"
              }`}
            >
              <p className="font-black text-xs uppercase tracking-tight">{p.name}</p>
              <p className={`text-[9px] font-bold ${pasajeroSeleccionadoEmail === p.email ? "text-white/60" : "text-slate-400"}`}>
                Esperando servicio...
              </p>
            </button>
          ))}
        </div>
      </section>

      {/* 3. 📡 TRÁFICO EN CURSO */}
      <section className="border border-slate-200 rounded-[2rem] p-4 bg-white flex flex-col shadow-sm overflow-hidden">
        <header className="flex justify-between items-center mb-3 border-b pb-2">
          <h3 className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-2">
            <Radio size={14}/> Monitor de Viajes
          </h3>
        </header>
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {viajesEnCurso.map(v => (
            <div key={v.email} className="bg-slate-50 p-3 rounded-2xl border border-slate-100 flex items-center gap-3">
              <div className="p-2 bg-white text-[#22c55e] rounded-xl shadow-sm"><User size={14}/></div>
              <div className="flex-1 min-w-0">
                <p className="font-black text-[10px] text-slate-700 truncate uppercase">{v.name}</p>
                <div className="flex items-center gap-1">
                   <div className="h-1 w-1 bg-[#22c55e] rounded-full animate-ping"></div>
                   <p className="text-[8px] text-[#22c55e] font-black uppercase tracking-widest">{v.estado}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>

    {/* 🚀 BARRA DE ACCIÓN INFERIOR (Estilo Valles Premium) */}
    <div className={`p-6 bg-white border-t-4 border-[#22c55e] transition-all duration-500 shadow-2xl ${pasajeroSeleccionado ? "translate-y-0 opacity-100" : "translate-y-full opacity-0 pointer-events-none"}`}>
      <div className="max-w-5xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-4">
            <div className="h-12 w-12 bg-[#22c55e]/10 rounded-2xl flex items-center justify-center text-[#22c55e]">
              <User size={24} />
            </div>
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase leading-none mb-1">Asignar Unidad a:</p>
              <p className="text-xl font-black text-[#22c55e] leading-none uppercase tracking-tighter">{pasajeroSeleccionado?.name}</p>
            </div>
        </div>
        <div className="flex gap-3">
            <button
              onClick={() => setPasajeroSeleccionadoEmail(null)}
              className="px-8 py-4 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-2xl font-black text-xs uppercase transition-all"
            >
              Cancelar
            </button>
            <div className="px-8 py-4 bg-[#22c55e] text-white rounded-2xl font-black text-xs animate-pulse flex items-center gap-3 shadow-lg shadow-green-900/20">
              <Car size={16} /> SELECCIONE UN TAXI DISPONIBLE
            </div>
        </div>
      </div>
    </div>
  </div>
);
};

export default PanelCentral;