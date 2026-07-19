import React, { useState, useCallback, useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { pasajeroIcon, taxistaIcon } from "../utils/icons";
import { socket } from "../lib/socket";
import { useSocketPayload } from "../hooks/useSocketPayload";
import { Car, User, Bell, Radio, Users, Activity, RefreshCcw } from "lucide-react";
import DispatchControl from "../components/DispatchControl";
import { POSITION_STATES, TAXI_DISPLAY_STATES } from "../constants/states";
import axiosInstance from "../lib/axiosConfig";

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

interface PassengerControlStats {
  totalRegistered: number;
  registeredLast7Days: number;
  registeredLast30Days: number;
  filteredRegistered?: number;
  generatedAt: string;
  filters?: {
    days: number | null;
    search: string | null;
    limit: number;
  };
  passengersRecent: Array<{
    _id?: string;
    name?: string;
    email: string;
    phone?: string;
    createdAt?: string;
  }>;
}

const PanelCentral: React.FC = () => {
  const { positions } = useSocketPayload();
  const [pasajeroSeleccionadoEmail, setPasajeroSeleccionadoEmail] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<"monitor" | "pasajeros">("monitor");
  const [passengerStats, setPassengerStats] = useState<PassengerControlStats | null>(null);
  const [passengerStatsLoading, setPassengerStatsLoading] = useState(false);
  const [passengerStatsError, setPassengerStatsError] = useState<string | null>(null);
  const [passengerPeriod, setPassengerPeriod] = useState<"all" | "today" | "7" | "30">("all");
  const [passengerSearchInput, setPassengerSearchInput] = useState("");
  const [passengerSearchTerm, setPassengerSearchTerm] = useState("");

  const CENTER_VALLES: [number, number] = [21.9850, -99.0150];
  const excludedPositionStates = [...TAXI_DISPLAY_STATES.DISCONNECTED, POSITION_STATES.CANCELADO, ...TAXI_DISPLAY_STATES.INACTIVE] as string[];
  const taxiOnlineBlockedStates = [...TAXI_DISPLAY_STATES.DISCONNECTED] as string[];

 const posicionesValidas = useMemo(() => {
  console.log("📡 Posiciones recibidas en Panel:", positions);
  return positions.filter(p => 
    esPosicionValida(p.lat, p.lng) &&
    !excludedPositionStates.includes(p.estado.toLowerCase())
  );
}, [positions]);

const pasajerosEspera = useMemo(() => 
  posicionesValidas.filter(u => 
    u.role === "pasajero" && 
    [POSITION_STATES.ACTIVO, "esperando", "solicitando", POSITION_STATES.BUSCANDO].map(s => s.toLowerCase()).includes(u.estado.toLowerCase())
  ),
  [posicionesValidas]
);

const viajesEnCurso = useMemo(() =>
  posicionesValidas.filter(u => 
    [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, "aceptado", "viajando", POSITION_STATES.ENCURSO, "ocupado"].map(s => s.toLowerCase()).includes(u.estado.toLowerCase())
  )
  .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()),
  [posicionesValidas]
);

const pasajerosActivosMapa = useMemo(() =>
  posicionesValidas.filter(u => u.role === "pasajero"),
  [posicionesValidas]
);

const pasajerosEnViajeMapa = useMemo(() => {
  const estadosViaje = [
    POSITION_STATES.ASIGNADO,
    POSITION_STATES.ENCAMINO,
    POSITION_STATES.ENCURSO,
    "aceptado",
    "viajando",
    "ocupado",
  ].map(s => s.toLowerCase());

  return pasajerosActivosMapa.filter(p => estadosViaje.includes((p.estado || "").toLowerCase()));
}, [pasajerosActivosMapa]);


  const taxistasOnline = useMemo(() => 
    posicionesValidas.filter(u => u.role === "taxista" && !taxiOnlineBlockedStates.includes(u.estado.toLowerCase())),
    [posicionesValidas]
  );

  // Objeto del pasajero actualmente seleccionado
  const pasajeroSeleccionado = useMemo(() => 
    posicionesValidas.find(p => p.email === pasajeroSeleccionadoEmail), 
    [posicionesValidas, pasajeroSeleccionadoEmail]
  );

  const taxistasCercanos = useMemo(() => {
  if (!pasajeroSeleccionado || !pasajeroSeleccionado.lat || !pasajeroSeleccionado.lng) return [];

  return [...taxistasOnline]
    .filter(t => !["desconectado", "cancelado", "inactivo"].includes(t.estado.toLowerCase()))
    .sort((a, b) => {
      const distA = getDistanceKm(pasajeroSeleccionado.lat!, pasajeroSeleccionado.lng!, a.lat!, a.lng!);
      const distB = getDistanceKm(pasajeroSeleccionado.lat!, pasajeroSeleccionado.lng!, b.lat!, b.lng!);
      return distA - distB;
    })
    .slice(0, 3);
}, [taxistasOnline, pasajeroSeleccionado]);

useEffect(() => {
  if (pasajeroSeleccionado) {
    const estaOcupado = [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO, "viajando", "aceptado", "ocupado"].map(s => s.toLowerCase()).includes(pasajeroSeleccionado.estado.toLowerCase());
    if (estaOcupado) {
      setPasajeroSeleccionadoEmail(null);
    }
  }
}, [pasajeroSeleccionado]);

useEffect(() => {
  if (pasajeroSeleccionado) {
    const estadoActual = pasajeroSeleccionado.estado.toLowerCase();
    const yaNoDisponible = ["asignado", "encamino", "encurso", "viajando", "aceptado", "ocupado", "cancelado"].includes(estadoActual);
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

  const fetchPassengerStats = useCallback(async () => {
    setPassengerStatsLoading(true);
    setPassengerStatsError(null);
    try {
      const periodDays =
        passengerPeriod === "today" ? 1 :
        passengerPeriod === "7" ? 7 :
        passengerPeriod === "30" ? 30 :
        null;

      const params: Record<string, string | number> = { limit: 200 };
      if (periodDays) params.days = periodDays;
      if (passengerSearchTerm.trim()) params.search = passengerSearchTerm.trim();

      const res = await axiosInstance.get<PassengerControlStats>("/api/admin/pasajeros/control", { params });
      setPassengerStats(res.data);
    } catch (error) {
      console.error("Error cargando control de pasajeros", error);
      setPassengerStatsError("No se pudo cargar el control de pasajeros");
    } finally {
      setPassengerStatsLoading(false);
    }
  }, [passengerPeriod, passengerSearchTerm]);

  useEffect(() => {
    if (panelTab !== "pasajeros") return;

    fetchPassengerStats();
    const refreshId = window.setInterval(fetchPassengerStats, 30000);

    return () => window.clearInterval(refreshId);
  }, [panelTab, fetchPassengerStats]);

  const runPassengerSearch = useCallback(() => {
    setPassengerSearchTerm(passengerSearchInput.trim());
  }, [passengerSearchInput]);

  const clearPassengerSearch = useCallback(() => {
    setPassengerSearchInput("");
    setPassengerSearchTerm("");
  }, []);

  const exportPassengersCsv = useCallback(() => {
    const rows = passengerStats?.passengersRecent || [];
    if (!rows.length) return;

    const escapeCsv = (value: string) => `"${String(value || "").replace(/"/g, '""')}"`;
    const header = ["nombre", "email", "telefono", "fecha_alta"];
    const body = rows.map((p) => [
      p.name || "Pasajero",
      p.email,
      p.phone || "",
      p.createdAt ? new Date(p.createdAt).toISOString() : "",
    ]);

    const csv = [header, ...body].map((line) => line.map(escapeCsv).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const datePart = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `pasajeros-control-${datePart}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [passengerStats]);

 return (
  <div className="flex flex-col h-screen w-full bg-white overflow-hidden font-sans">
    
    {/* 🟢 BARRA SUPERIOR INSTITUCIONAL */}
    <header className="bg-[#22c55e] py-2 px-4 flex justify-between items-center shadow-md z-[1001]">
      <h1 className="text-white font-black tracking-tighter text-sm italic uppercase">
        Panel Central <span className="text-white/150">| Ciudad Valles</span>
      </h1>
      <div className="flex items-center gap-3">
        <div className="bg-white/20 p-1 rounded-xl flex items-center gap-1">
          <button
            onClick={() => setPanelTab("monitor")}
            className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${
              panelTab === "monitor" ? "bg-white text-[#15803d]" : "text-white/80 hover:text-white"
            }`}
          >
            Monitor
          </button>
          <button
            onClick={() => setPanelTab("pasajeros")}
            className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${
              panelTab === "pasajeros" ? "bg-white text-[#15803d]" : "text-white/80 hover:text-white"
            }`}
          >
            Pasajeros
          </button>
        </div>
        <div className="flex items-center gap-2 text-white/80 text-[10px] font-bold uppercase tracking-widest">
          <span>App Oficial</span>
          <div className="h-2 w-2 bg-green-400 rounded-full animate-pulse"></div>
        </div>
      </div>
    </header>

    {panelTab === "pasajeros" ? (
      <div className="flex-1 overflow-y-auto bg-slate-50 p-4 md:p-6">
        <div className="max-w-7xl mx-auto space-y-5">
          <section className="bg-white rounded-[1.8rem] border border-slate-200 p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-black uppercase tracking-widest text-slate-700 flex items-center gap-2">
                  <Users size={16} className="text-[#22c55e]" />
                  Control de Pasajeros
                </h2>
                <p className="text-[11px] text-slate-500 font-semibold mt-1">
                  Registro, actividad en mapa y nuevos usuarios.
                </p>
              </div>
              <button
                onClick={fetchPassengerStats}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-100 transition-colors text-[11px] font-bold uppercase"
              >
                <RefreshCcw size={12} /> Actualizar
              </button>
            </div>

            <div className="flex flex-col lg:flex-row gap-3 mb-4">
              <div className="flex flex-wrap gap-2">
                {["all", "today", "7", "30"].map((period) => {
                  const label = period === "all" ? "Todo" : period === "today" ? "Hoy" : `${period} días`;
                  const active = passengerPeriod === period;
                  return (
                    <button
                      key={period}
                      onClick={() => setPassengerPeriod(period as "all" | "today" | "7" | "30")}
                      className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider border transition-colors ${
                        active ? "bg-[#22c55e] text-white border-[#22c55e]" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="flex-1 flex flex-col sm:flex-row gap-2">
                <input
                  value={passengerSearchInput}
                  onChange={(e) => setPassengerSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") runPassengerSearch();
                  }}
                  placeholder="Buscar por nombre, correo o teléfono"
                  className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-[#22c55e]/30"
                />
                <button
                  onClick={runPassengerSearch}
                  className="px-3 py-2 rounded-xl bg-slate-800 text-white text-[11px] font-black uppercase"
                >
                  Buscar
                </button>
                <button
                  onClick={clearPassengerSearch}
                  className="px-3 py-2 rounded-xl border border-slate-200 text-slate-600 text-[11px] font-black uppercase"
                >
                  Limpiar
                </button>
              </div>
            </div>

            {passengerStatsError && (
              <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-xs font-bold uppercase">
                {passengerStatsError}
              </div>
            )}

            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-slate-500 font-semibold">
                Coincidencias: <span className="font-black text-slate-700">{passengerStats?.filteredRegistered ?? passengerStats?.passengersRecent?.length ?? 0}</span>
              </p>
              <button
                onClick={exportPassengersCsv}
                disabled={!passengerStats?.passengersRecent?.length}
                className="px-3 py-2 rounded-xl border border-[#22c55e]/30 text-[#15803d] bg-[#22c55e]/10 disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-black uppercase"
              >
                Exportar CSV
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Registrados</p>
                <p className="text-3xl font-black text-slate-800 mt-1">{passengerStats?.totalRegistered ?? "--"}</p>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">En mapa ahora</p>
                <p className="text-3xl font-black text-[#22c55e] mt-1">{pasajerosActivosMapa.length}</p>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Esperando taxi</p>
                <p className="text-3xl font-black text-amber-600 mt-1">{pasajerosEspera.length}</p>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">En viaje</p>
                <p className="text-3xl font-black text-cyan-600 mt-1">{pasajerosEnViajeMapa.length}</p>
              </article>
            </div>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <article className="bg-white rounded-[1.8rem] border border-slate-200 p-5 shadow-sm lg:col-span-1">
              <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-600 mb-3 flex items-center gap-2">
                <Activity size={13} className="text-[#22c55e]" /> Altas recientes
              </h3>
              <div className="space-y-3">
                <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                  <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Últimos 7 días</p>
                  <p className="text-2xl font-black text-slate-800">{passengerStats?.registeredLast7Days ?? "--"}</p>
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                  <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Últimos 30 días</p>
                  <p className="text-2xl font-black text-slate-800">{passengerStats?.registeredLast30Days ?? "--"}</p>
                </div>
              </div>
              <p className="text-[10px] text-slate-400 mt-3 font-semibold">
                Corte: {passengerStats?.generatedAt ? new Date(passengerStats.generatedAt).toLocaleString() : "sin datos"}
              </p>
            </article>

            <article className="bg-white rounded-[1.8rem] border border-slate-200 p-5 shadow-sm lg:col-span-2">
              <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-600 mb-3">
                Últimos Pasajeros Registrados
              </h3>

              {passengerStatsLoading && !passengerStats ? (
                <p className="text-sm font-bold text-slate-500">Cargando datos...</p>
              ) : (
                <div className="max-h-[420px] overflow-y-auto space-y-2 pr-1">
                  {(passengerStats?.passengersRecent || []).map((p) => (
                    <div
                      key={p._id || p.email}
                      className="rounded-xl border border-slate-200 px-3 py-2 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-black text-slate-800 truncate uppercase">{p.name || "Pasajero"}</p>
                        <p className="text-[11px] text-slate-500 font-semibold truncate">{p.email}</p>
                        <p className="text-[10px] text-slate-400 font-semibold">{p.phone || "Sin teléfono"}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] font-black uppercase text-[#22c55e]">Alta</p>
                        <p className="text-[10px] text-slate-500 font-semibold">
                          {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "N/D"}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </section>
        </div>
      </div>
    ) : (
      <>

    {/* 🗺️ MAPA (Con borde sutil) */}
    <div className="h-[45%] w-full relative border-b-4 border-[#22c55e]/10">
      <MapContainer center={CENTER_VALLES} zoom={14} style={{ height: "100%", width: "100%" }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        
        {pasajeroSeleccionado && (
          <ChangeView center={[pasajeroSeleccionado.lat!, pasajeroSeleccionado.lng!]} />
        )}

        {posicionesValidas.map((u) => {
          const estaEnViaje = ["asignado", "encamino", "encurso", "viajando", "aceptado", "ocupado"].includes(u.estado.toLowerCase());

          return (
            <Marker 
              key={u.email}
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
      </>
    )}
  </div>
);
};

export default PanelCentral;