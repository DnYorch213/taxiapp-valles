import React, { useState, useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, Marker } from "react-leaflet";
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

// --- SUB-COMPONENTE: BARRA DE TIEMPO ---
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
  
  // 🎵 REFERENCIA DE AUDIO CENTRALIZADA
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 1. Inicialización del Audio
  useEffect(() => {
    audioRef.current = new Audio("/sounds/alerta_taxi.mp3");
    if (audioRef.current) {
      audioRef.current.loop = true;
      audioRef.current.load();
    }
    return () => detenerSonido();
  }, []);

  const detenerSonido = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };

  const reproducirAlerta = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(err => console.log("Audio bloqueado:", err));
    }
  };

  // 2. Lógica de Notificaciones Push
  useEffect(() => {
    const activarNotificaciones = async () => {
      if (!userPosition?.email || !VAPID_PUBLIC_KEY) return;
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
          });
        }
        await axios.post(`${API_URL}/save-subscription`, {
          email: userPosition.email,
          subscription: subscription
        });
      } catch (error) {
        console.error("Error Push:", error);
      }
    };
    if (userPosition?.role === "taxista") activarNotificaciones();
  }, [userPosition?.email, userPosition?.role]);

  // 3. Geolocation
  useGeolocation(
    {
      email: userPosition?.email || localStorage.getItem("email") || "",
      name: localStorage.getItem("userName") || userPosition?.name || "Taxista",
      role: "taxista",
      taxiNumber: userPosition?.taxiNumber || localStorage.getItem("taxiNumber") || "",
    },
    (pos) => {
      if (userPosition) setUserPosition({ ...userPosition, lat: pos.lat, lng: pos.lng });
    }
  );

  // 4. Lógica de Sockets Sincronizada
  useEffect(() => {
    if (!socket) return;

    socket.on("pasajero_asignado", (data: Payload & { excludedEmails?: string[] }) => {
      setPasajeroAsignado(data);
      setExcludedEmails(data.excludedEmails || []);
      setEstado("Asignado");
      
      reproducirAlerta(); // 🔔 Usamos el Ref

      if ("vibrate" in navigator) navigator.vibrate([500, 200, 500]);
      toast.info(`¡NUEVO SERVICIO!`, { position: "top-center" });
    });

    socket.on("dispatch_timeout", () => {
      console.log("⏰ Tiempo agotado por el servidor.");
      detenerSonido(); // 🛑 Detiene el Ref
      setPasajeroAsignado(null);
      setEstado("Disponible");
      toast.warn("El tiempo para aceptar ha expirado", { position: "top-center" });
    });

    socket.on("trip_cancelled_by_passenger", () => {
      detenerSonido(); // 🛑 Detiene el Ref
      setPasajeroAsignado(null);
      setEstado("Disponible");
      setChatAbierto(false);
      toast.error("El pasajero canceló el viaje");
    });

    return () => {
      socket.off("pasajero_asignado");
      socket.off("dispatch_timeout");
      socket.off("trip_cancelled_by_passenger");
    };
  }, [socket]);

  // --- ACCIONES DEL USUARIO ---
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
  };

  const finalizarViaje = () => {
    if (!pasajeroAsignado) return;
    socket.emit("end_trip", { pasajeroEmail: pasajeroAsignado.email, taxistaEmail: userPosition?.email });
    setEstado("Disponible");
    setPasajeroAsignado(null);
    setChatAbierto(false);
  };

  const puntosRuta = useMemo(() => {
    if (pasajeroAsignado?.lat && userPosition?.lat && (estado === "EnCamino" || estado === "Asignado")) {
      return [L.latLng(userPosition.lat!, userPosition.lng!), L.latLng(pasajeroAsignado.lat!, pasajeroAsignado.lng!)];
    }
    return [];
  }, [pasajeroAsignado, userPosition, estado]);

  return (
    <div className="h-screen bg-slate-50 flex flex-col overflow-hidden font-sans relative">
      <ToastContainer theme="light" />

      {/* MAPA */}
      <div className="flex-1 w-full relative">
        {userPosition?.lat ? (
          <MapContainer center={[userPosition.lat!, userPosition.lng!]} zoom={15} className="h-full w-full" zoomControl={false}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {puntosRuta.length > 0 && <RoutingMachine waypoints={puntosRuta} />}
            <Marker position={[userPosition.lat!, userPosition.lng!]} icon={taxistaIcon} />
            {pasajeroAsignado?.lat && <Marker position={[pasajeroAsignado.lat!, pasajeroAsignado.lng!]} icon={pasajeroIcon} />}
          </MapContainer>
        ) : (
          <div className="h-full w-full flex items-center justify-center bg-slate-100 text-slate-400 text-[10px] font-black uppercase italic animate-pulse">
            🛰️ Sincronizando GPS Valles...
          </div>
        )}

        <div className="absolute top-6 left-6 z-[1000] bg-white px-4 py-2 rounded-2xl shadow-2xl border border-slate-100 flex items-center gap-3">
          <div className={`h-2.5 w-2.5 rounded-full ${estado === "Disponible" ? "bg-[#22c55e]" : "bg-orange-500 animate-ping"}`}></div>
          <span className="text-[11px] font-black text-slate-800 uppercase tracking-widest">{estado}</span>
        </div>
      </div>

      {/* SECCIÓN DE CONTROL */}
      <div className="bg-white rounded-t-[3.5rem] shadow-[0_-25px_60px_rgba(0,0,0,0.15)] p-8 z-[1001] relative border-t border-slate-50 transition-all duration-700">
        <div className="absolute top-4 left-1/2 -translate-x-1/2 w-16 h-1.5 bg-slate-200 rounded-full"></div>

        {pasajeroAsignado ? (
          <div className="space-y-6 pt-4 animate-in slide-in-from-bottom-6 duration-500">
            <div className={`relative p-6 rounded-[2.5rem] transition-all duration-500 overflow-hidden ${
              estado === "Asignado" 
                ? "bg-[#22c55e] shadow-2xl shadow-green-200 ring-4 ring-green-100" 
                : "bg-slate-50 border-2 border-slate-100"
            }`}>
              {estado === "Asignado" && <div className="absolute -right-4 -top-4 text-8xl opacity-10 rotate-12 pointer-events-none">⚡</div>}

              <div className="flex items-center gap-6 relative z-10">
                <div className={`w-20 h-20 rounded-[2rem] flex items-center justify-center shadow-lg transform transition-all duration-500 ${
                  estado === "EnCurso" 
                    ? "bg-green-50 border-2 border-[#22c55e] scale-105" 
                    : estado === "Asignado" 
                      ? "bg-white rotate-3 shadow-green-200" 
                      : "bg-white border border-slate-200"
                }`}>
                  {estado === "EnCurso" ? (
                    <div className="text-[#22c55e] animate-in zoom-in duration-300">
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    </div>
                  ) : (
                    <span className={`text-4xl ${estado === "Asignado" ? "animate-pulse" : "text-slate-400"}`}>👤</span>
                  )}
                </div>

                <div className="flex-1">
                  <p className={`text-[10px] font-black uppercase tracking-[0.2em] mb-1 ${estado === "EnCurso" ? "text-[#22c55e]" : estado === "Asignado" ? "text-white/80" : "text-slate-400"}`}>
                    {estado === "Asignado" && "¡Nueva Solicitud!"}
                    {estado === "EnCamino" && "En Ruta al punto"}
                    {estado === "EnCurso" && "Servicio Confirmado ✅"}
                  </p>
                  <h3 className={`text-2xl font-black tracking-tighter leading-tight ${estado === "Asignado" ? "text-white" : "text-slate-800"}`}>
                    {pasajeroAsignado.name}
                  </h3>
                  {estado === "Asignado" && <TimerBar duration={15000} onFinish={() => rechazarViaje()} />}
                </div>
              </div>
            </div>

            <div className={`flex flex-col gap-4 transition-all duration-500 ${estado === "EnCamino" || estado === "EnCurso" ? "pb-24" : "pb-4"}`}>
              {estado === "Asignado" && (
                <div className="grid grid-cols-5 gap-3">
                  <button onClick={aceptarViaje} className="col-span-3 py-6 bg-[#22c55e] hover:bg-[#16a34a] text-white rounded-[2rem] font-black text-lg uppercase shadow-xl active:scale-95 transition-all">ACEPTAR</button>
                  <button onClick={rechazarViaje} className="col-span-2 py-6 bg-slate-100 text-slate-400 rounded-[2rem] font-black text-xs uppercase active:scale-95 border-2 border-slate-200/50">IGNORAR</button>
                </div>
              )}

              {estado === "EnCamino" && (
                <button onClick={confirmarAbordo} className="w-full py-7 bg-slate-900 text-white rounded-[2.5rem] font-black text-xl uppercase shadow-2xl active:scale-95 transition-all flex items-center justify-center gap-3 border-b-8 border-slate-800">
                  <span className="text-2xl">📍</span> CONFIRMAR ABORDO
                </button>
              )}

              {estado === "EnCurso" && (
                <button onClick={finalizarViaje} className="w-full py-7 bg-red-600 hover:bg-red-700 text-white rounded-[2.5rem] font-black text-xl uppercase shadow-xl active:scale-95 border-b-8 border-red-800">
                  🏁 FINALIZAR SERVICIO
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="py-16 flex flex-col items-center justify-center text-center animate-in fade-in zoom-in duration-700">
            <div className="relative">
              <div className="absolute inset-0 bg-[#22c55e]/20 blur-3xl rounded-full"></div>
              <div className="relative w-24 h-24 bg-white border-4 border-[#22c55e] rounded-[2rem] flex items-center justify-center text-5xl shadow-2xl mb-6">🚕</div>
            </div>
            <h2 className="text-2xl font-black text-slate-800 tracking-tighter uppercase italic">VALLES<span className="text-[#22c55e]">CONECTA</span></h2>
            <p className="text-slate-400 text-xs font-bold uppercase tracking-[0.3em] mt-2">Buscando pasajeros...</p>
          </div>
        )}
      </div>

      {/* CHAT COLAPSABLE */}
      {pasajeroAsignado && pasajeroAsignado.email && estado === "EnCamino" && (
        <div className={`fixed bottom-0 left-0 w-full z-[2000] transition-all duration-500 ease-in-out ${chatAbierto ? "translate-y-0" : "translate-y-[calc(100%-70px)]"}`}>
          <div className="max-w-md mx-auto bg-white rounded-t-[2.5rem] shadow-[0_-20px_50px_rgba(0,0,0,0.2)] border-x border-t border-slate-100 overflow-hidden">
            <div onClick={() => setChatAbierto(!chatAbierto)} className="h-[70px] flex items-center justify-between px-8 cursor-pointer border-b border-slate-50 active:bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 bg-[#22c55e] rounded-2xl flex items-center justify-center text-xl shadow-lg shadow-green-100 text-white">💬</div>
                <h3 className="text-[11px] font-black text-slate-800 uppercase tracking-widest">Chat con Pasajero</h3>
                <div className="flex items-center gap-3"></div>
              </div>
              <div className={`transform transition-transform duration-500 ${chatAbierto ? "rotate-180" : "rotate-0"}`}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
              </div>
            </div>
            <div className="h-[400px] bg-white">
              <ChatBox toEmail={pasajeroAsignado.email} userName={`Taxi ECO-${userPosition?.taxiNumber || 'Valles'}`} />
            </div>
          </div>
        </div>
      )}

      <div className="h-2 bg-[#22c55e] w-full"></div>
    </div>
  );
};

export default TaxistaView;