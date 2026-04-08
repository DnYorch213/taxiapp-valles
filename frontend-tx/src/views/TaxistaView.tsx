import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Polyline } from "react-leaflet"; // 🚩 Importamos Polyline
import { toast, ToastContainer } from "react-toastify";
import L from 'leaflet';
import axios from "axios";
import "react-toastify/dist/ReactToastify.css";
import "leaflet/dist/leaflet.css";

import { socket } from "../lib/socket";
import { useTravel } from "../context/TravelContext";
import { useGeolocation } from "../hooks/useGeolocation";
import { Payload } from "../types/Payload";
import { ChatBox } from "../components/ChatBox";
import { RoutingMachine } from "../components/RoutingMachine";
import { taxistaIcon, pasajeroIcon } from "../utils/icons";

// --- UTILIDADES ---
function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";
const VAPID_PUBLIC_KEY = "BHtVjCOYiH1nbyPq-mPS_ZqA0oHjGcONq5r5PV-sTC1jXzAvgGuFFwL5iv0ymk725NUX4_obl82JLilVs9W49-A";

const TimerBar: React.FC<{ duration: number; onFinish: () => void }> = ({ duration, onFinish }) => {
  const [progress, setProgress] = useState(100);
  useEffect(() => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
      setProgress(remaining);
      if (remaining === 0) {
        clearInterval(interval);
        onFinish();
      }
    }, 50);
    return () => clearInterval(interval);
  }, [duration, onFinish]);

  return (
    <div className="w-full h-2 bg-white/20 rounded-full overflow-hidden mt-3 border border-white/10">
      <div 
        className="h-full bg-white transition-all duration-75 ease-linear shadow-[0_0_8px_rgba(255,255,255,0.8)]"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
};

const TaxistaView: React.FC = () => {
  const { userPosition, setUserPosition } = useTravel();
  const [estado, setEstado] = useState<"Disponible" | "Asignado" | "EnCurso" | "EnCamino">("Disponible");
  const [pasajeroAsignado, setPasajeroAsignado] = useState<Payload | null>(null);
  const [excludedEmails, setExcludedEmails] = useState<string[]>([]);
  const [chatAbierto, setChatAbierto] = useState(false);
  
  // 🚩 ESTADO PARA EL RASTRO DEL VIAJE
  const [historialRuta, setHistorialRuta] = useState<L.LatLngExpression[]>([]);
  
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const estadoRef = useRef(estado);

  useEffect(() => { 
    estadoRef.current = estado; 
  }, [estado]);

  // --- AUDIO & NOTIFICACIONES ---
  const detenerSonido = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, []);

  const reproducirAlerta = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(err => console.log("Audio bloqueado:", err));
    }
  }, []);

  useEffect(() => {
    audioRef.current = new Audio("/sounds/alerta_taxi.mp3");
    if (audioRef.current) {
      audioRef.current.loop = true;
      audioRef.current.load();
    }
    return () => detenerSonido();
  }, [detenerSonido]);

 // --- 🛰️ GEOLOCALIZACIÓN REFACTOREADA ---
useGeolocation(
  {
    email: userPosition?.email || localStorage.getItem("email") || "",
    name: localStorage.getItem("userName") || userPosition?.name || "Taxista",
    role: "taxista",
    taxiNumber: userPosition?.taxiNumber || localStorage.getItem("taxiNumber") || "",
  },
  (pos) => {
    // 🛡️ VALIDACIÓN CRUCIAL: Solo procedemos si pos.lat y pos.lng son números válidos
    if (pos.lat === null || pos.lng === null) return;

    // 1. Actualización local
    if (userPosition) {
      setUserPosition({ ...userPosition, lat: pos.lat, lng: pos.lng });
    }

    const estadoActual = estadoRef.current;
    
    // 2. Envío al socket
    if (socket && (estadoActual === "Asignado" || estadoActual === "EnCamino" || estadoActual === "EnCurso")) {
      socket.emit("taxi_moved", {
        lat: pos.lat, // Aquí TypeScript ya sabe que es 'number'
        lng: pos.lng, // Aquí también
        email: userPosition?.email || localStorage.getItem("email"),
        taxiNumber: userPosition?.taxiNumber || localStorage.getItem("taxiNumber"),
        role: "taxista"
      });

      if (estadoActual === "EnCurso") {
        // Usamos la aserción de tipo o la validación previa para el historial
        const nuevaCoord: L.LatLngExpression = [pos.lat, pos.lng];
        setHistorialRuta((prev) => [...prev, nuevaCoord]);
        
        socket.emit("update_trip_path", {
          pasajeroEmail: pasajeroAsignado?.email,
          lat: pos.lat,
          lng: pos.lng
        });
      }
    }
  }
);

  // --- 🔄 LÓGICA DE SOCKETS ---
  const checkStatus = useCallback(() => {
    const miEmail = userPosition?.email || localStorage.getItem("email");
    const miRole = localStorage.getItem("role");
    if (miEmail && socket.connected) {
      socket.emit("reproducir_estado_viaje", { 
        email: miEmail.toLowerCase().trim(),
        role: miRole 
      });
    }
  }, [userPosition?.email]);

  const handleAsignacion = useCallback((data: any) => {
    setPasajeroAsignado(data);
    setExcludedEmails(data.excludedEmails || []);
    const estadoServidor = data.estado?.toLowerCase();

    if (estadoServidor === "en curso" || estadoServidor === "ocupado") {
      setEstado("EnCurso");
      detenerSonido();
    } else if (estadoServidor === "asignado") {
      setEstado("EnCamino"); 
      detenerSonido();
    } else {
      setEstado("Asignado"); 
      reproducirAlerta();
    }
  }, [detenerSonido, reproducirAlerta]);

  useEffect(() => {
    if (!socket) return;

    socket.on("pasajero_asignado", handleAsignacion);
    socket.on("dispatch_timeout", () => {
      detenerSonido();
      setPasajeroAsignado(null);
      setEstado("Disponible");
    });
    socket.on("trip_cancelled_by_passenger", () => {
      detenerSonido();
      setPasajeroAsignado(null);
      setEstado("Disponible");
      setChatAbierto(false);
      setHistorialRuta([]); // Limpiar rastro
    });

    socket.on("trip_finished", () => {
      detenerSonido();
      setEstado("Disponible");
      setPasajeroAsignado(null);
      setChatAbierto(false);
      setHistorialRuta([]); // Limpiar rastro
    });

    if (socket.connected) checkStatus();

    return () => {
      socket.off("pasajero_asignado");
      socket.off("dispatch_timeout");
      socket.off("trip_cancelled_by_passenger");
      socket.off("trip_finished");
    };
  }, [handleAsignacion, checkStatus, detenerSonido]);

  // --- ACCIONES DEL TAXISTA ---
  const aceptarViaje = () => {
    if (!pasajeroAsignado) return;
    detenerSonido();
    socket.emit("taxi_response", { requestEmail: pasajeroAsignado.email, accepted: true, excludedEmails });
    setEstado("EnCamino");
  };

  const rechazarViaje = () => {
    if (!pasajeroAsignado) return;
    detenerSonido();
    socket.emit("taxi_response", { requestEmail: pasajeroAsignado.email, accepted: false, excludedEmails });
    setPasajeroAsignado(null);
    setEstado("Disponible");
  };

  const confirmarAbordo = () => {
    if (!pasajeroAsignado) return;
    socket.emit("passenger_on_board", { taxistaEmail: userPosition?.email, pasajeroEmail: pasajeroAsignado.email });
    setEstado("EnCurso");
    setChatAbierto(false);
    // 🚩 Al abordar, iniciamos el historial con la posición actual
    if (userPosition?.lat) {
      setHistorialRuta([[userPosition.lat, userPosition.lng!]]);
    }
  };

  const finalizarViaje = () => {
    if (!pasajeroAsignado) return;
    socket.emit("end_trip", { 
      pasajeroEmail: pasajeroAsignado.email, 
      taxistaEmail: userPosition?.email 
    });
    setEstado("Disponible");
    setPasajeroAsignado(null);
    setHistorialRuta([]); // Limpiar historial al terminar
    toast.info("Servicio finalizado");
  };

  // --- MAPA & RUTA ---
  const puntosRuta = useMemo(() => {
    // 🚩 Solo usamos RoutingMachine para ir a buscar al pasajero (EnCamino)
    if (estado === "EnCamino" && pasajeroAsignado?.lat && userPosition?.lat) {
      return [L.latLng(userPosition.lat!, userPosition.lng!), L.latLng(pasajeroAsignado.lat!, pasajeroAsignado.lng!)];
    }
    return [];
  }, [pasajeroAsignado, userPosition, estado]);

  return (
    <div className="h-screen bg-[#0f172a] flex flex-col overflow-hidden font-sans relative text-slate-100">
      <ToastContainer theme="dark" />

      <div className="flex-1 w-full relative">
        {userPosition?.lat ? (
          <MapContainer 
            center={[userPosition.lat!, userPosition.lng!]} 
            zoom={15} 
            className="h-full w-full"
            zoomControl={false}
          >
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            
            {/* 1. Ruta sugerida (Solo antes del abordo) */}
            {puntosRuta.length > 0 && <RoutingMachine waypoints={puntosRuta} />}
            
            {/* 2. 🚩 RASTRO EN VIVO (Cuando ya abordó) */}
            {estado === "EnCurso" && (
              <Polyline 
                positions={historialRuta} 
                pathOptions={{ color: '#22c55e', weight: 6, opacity: 0.8 }} 
              />
            )}

            <Marker position={[userPosition.lat!, userPosition.lng!]} icon={taxistaIcon} />
            
            {/* 3. 🚩 OCULTAR PASAJERO SI YA ABORDÓ (EnCurso) */}
            {pasajeroAsignado?.lat && estado !== "EnCurso" && (
              <Marker position={[pasajeroAsignado.lat!, pasajeroAsignado.lng!]} icon={pasajeroIcon} />
            )}
          </MapContainer>
        ) : (
          <div className="h-full w-full flex items-center justify-center bg-[#1e293b] text-slate-500 text-[10px] font-black uppercase italic animate-pulse">
            🛰️ Sincronizando GPS Valles...
          </div>
        )}

        <div className="absolute top-6 left-6 z-[1000] bg-[#1e293b]/90 backdrop-blur-md px-4 py-2 rounded-2xl shadow-2xl border border-white/10 flex items-center gap-3">
          <div className={`h-2.5 w-2.5 rounded-full ${estado === "Disponible" ? "bg-[#22c55e]" : "bg-orange-500 animate-ping"}`}></div>
          <span className="text-[11px] font-black text-white uppercase tracking-widest">{estado}</span>
        </div>
      </div>

      <div className="bg-[#1e293b] rounded-t-[3.5rem] shadow-[0_-25px_60px_rgba(0,0,0,0.5)] p-8 z-[1001] relative border-t border-white/5">
        <div className="absolute top-4 left-1/2 -translate-x-1/2 w-16 h-1.5 bg-slate-700 rounded-full"></div>

        {pasajeroAsignado ? (
          <div className="space-y-6 pt-4 animate-in slide-in-from-bottom-6 duration-500">
            <div className={`relative p-6 rounded-[2.5rem] transition-all duration-500 ${
              estado === "Asignado" ? "bg-[#22c55e] shadow-2xl" : "bg-[#0f172a]/50 border-2 border-white/5"
            }`}>
              <div className="flex items-center gap-6">
                <div className="w-20 h-20 rounded-[2rem] bg-white flex items-center justify-center text-4xl shadow-lg">👤</div>
                <div className="flex-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-white/70">
                    {estado === "EnCurso" ? "Viaje en Progreso" : "Pasajero asignado"}
                  </p>
                  <h3 className="text-2xl font-black text-white">{pasajeroAsignado.name}</h3>
                  {estado === "Asignado" && <TimerBar duration={15000} onFinish={rechazarViaje} />}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              {estado === "Asignado" && (
                <div className="grid grid-cols-5 gap-3">
                  <button onClick={aceptarViaje} className="col-span-3 py-6 bg-[#22c55e] text-[#0f172a] rounded-[2rem] font-black text-lg shadow-lg">ACEPTAR</button>
                  <button onClick={rechazarViaje} className="col-span-2 py-6 bg-slate-800 text-slate-400 rounded-[2rem] font-black text-xs">IGNORAR</button>
                </div>
              )}

              {estado === "EnCamino" && (
                <button onClick={confirmarAbordo} className="w-full py-7 bg-white text-[#0f172a] rounded-[2.5rem] font-black text-xl flex items-center justify-center gap-3 border-b-8 border-slate-300">
                  📍 CONFIRMAR ABORDO
                </button>
              )}

              {estado === "EnCurso" && (
                <button onClick={finalizarViaje} className="w-full py-7 bg-red-600 text-white rounded-[2.5rem] font-black text-xl border-b-8 border-red-900 shadow-xl">
                  🏁 FINALIZAR SERVICIO
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="py-16 flex flex-col items-center justify-center">
            <div className="w-24 h-24 bg-[#0f172a] border-4 border-[#22c55e] rounded-[2rem] flex items-center justify-center text-5xl mb-6 shadow-xl">🚕</div>
            <h2 className="text-2xl font-black text-white uppercase italic">VALLES<span className="text-[#22c55e]">CONECTA</span></h2>
            <p className="text-slate-500 text-xs font-bold uppercase tracking-[0.3em] mt-2">Buscando pasajeros...</p>
          </div>
        )}
      </div>

      {/* CHAT: Solo visible antes de que el pasajero aborde */}
      {pasajeroAsignado?.email && estado === "EnCamino" && (
        <div className={`fixed bottom-0 left-0 w-full z-[2000] transition-all duration-500 ${chatAbierto ? "translate-y-0" : "translate-y-[calc(100%-70px)]"}`}>
          <div className="max-w-md mx-auto bg-[#1e293b] rounded-t-[2.5rem] shadow-2xl overflow-hidden">
            <div onClick={() => setChatAbierto(!chatAbierto)} className="h-[70px] flex items-center justify-between px-8 cursor-pointer active:bg-slate-800">
              <span className="text-[11px] font-black text-white uppercase">Mensajería Directa</span>
              <span className="text-[#22c55e]">{chatAbierto ? '▼' : '▲'}</span>
            </div>
            <div className="h-[400px] bg-[#0f172a]">
              <ChatBox toEmail={pasajeroAsignado.email} userName={`Taxi ECO-${userPosition?.taxiNumber || 'Valles'}`} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaxistaView;