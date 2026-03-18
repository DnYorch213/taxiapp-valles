import React, { useState, useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, Marker } from "react-leaflet";
import { toast, ToastContainer } from "react-toastify";
import L from 'leaflet';
import "react-toastify/dist/ReactToastify.css";
import "leaflet/dist/leaflet.css";

import { socket } from "../lib/socket";
import { useTravel } from "../context/TravelContext";
import { useGeolocation } from "../hooks/useGeolocation";
import { Payload } from "../types/Payload";
import { ChatBox } from "../components/ChatBox";
import { RoutingMachine } from "../components/RoutingMachine";
import { taxistaIcon, pasajeroIcon } from "../utils/icons";

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
    <div className="w-full h-1.5 bg-slate-900/20 rounded-full overflow-hidden mt-3 border border-black/5">
      <div 
        className={`h-full transition-all duration-75 ease-linear ${
          progress > 50 ? 'bg-green-600' : progress > 20 ? 'bg-orange-500' : 'bg-red-600'
        }`}
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
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    audioRef.current = new Audio("/sounds/alerta_taxi.mp3");
    if (audioRef.current) audioRef.current.loop = true;
    return () => detenerSonido();
  }, []);

  const detenerSonido = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };

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

  useEffect(() => {
    if (!socket) return;

    socket.on("pasajero_asignado", (data: Payload & { excludedEmails?: string[] }) => {
      setPasajeroAsignado(data);
      setExcludedEmails(data.excludedEmails || []);
      setEstado("Asignado");
      if (audioRef.current) audioRef.current.play().catch(() => {});
      if ("vibrate" in navigator) navigator.vibrate([500, 200, 500]);
      
      toast.info(`¡SERVICIO ENTRANTE!`, { position: "top-center", autoClose: 14000 });
    });

    socket.on("trip_cancelled_by_passenger", () => {
      detenerSonido();
      setPasajeroAsignado(null);
      setEstado("Disponible");
      setExcludedEmails([]);
      toast.error("El pasajero canceló el viaje");
    });

    return () => {
      socket.off("pasajero_asignado");
      socket.off("trip_cancelled_by_passenger");
    };
  }, []);

  const puntosRuta = useMemo(() => {
    if (pasajeroAsignado?.lat && userPosition?.lat && (estado === "EnCamino" || estado === "Asignado")) {
      return [L.latLng(userPosition.lat!, userPosition.lng!), L.latLng(pasajeroAsignado.lat!, pasajeroAsignado.lng!)];
    }
    return [];
  }, [pasajeroAsignado, userPosition, estado]);

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
  };

  const finalizarViaje = () => {
    if (!pasajeroAsignado) return;
    socket.emit("end_trip", { pasajeroEmail: pasajeroAsignado.email, taxistaEmail: userPosition?.email });
    setEstado("Disponible");
    setPasajeroAsignado(null);
  };

  return (
    <div className="h-screen bg-slate-900 flex flex-col overflow-hidden font-sans">
      <ToastContainer theme="dark" />

      {/* SECCIÓN MAPA */}
      <div className="h-[40%] w-full relative">
        {userPosition?.lat ? (
          <MapContainer center={[userPosition.lat!, userPosition.lng!]} zoom={15} className="h-full w-full" zoomControl={false}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {puntosRuta.length > 0 && <RoutingMachine waypoints={puntosRuta} />}
            <Marker position={[userPosition.lat!, userPosition.lng!]} icon={taxistaIcon} />
            {pasajeroAsignado?.lat && <Marker position={[pasajeroAsignado.lat!, pasajeroAsignado.lng!]} icon={pasajeroIcon} />}
          </MapContainer>
        ) : (
          <div className="h-full w-full flex items-center justify-center bg-slate-800 text-slate-500 text-[10px] font-black uppercase">Buscando GPS...</div>
        )}
        <div className="absolute top-4 right-4 z-[1000] bg-slate-900/90 backdrop-blur px-4 py-1.5 rounded-full border border-white/10 flex items-center gap-2 shadow-2xl">
          <div className={`h-2 w-2 rounded-full ${userPosition?.lat ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
          <span className="text-[10px] text-white font-black uppercase tracking-widest">{estado}</span>
        </div>
      </div>

      {/* SECCIÓN INFORMACIÓN */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {pasajeroAsignado ? (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className={`p-5 rounded-[2.5rem] shadow-2xl transition-all duration-500 ${estado === "Asignado" ? "bg-yellow-400 scale-105" : "bg-white"}`}>
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 bg-slate-900 rounded-3xl flex items-center justify-center text-2xl">👤</div>
                <div className="flex-1">
                  <p className={`text-[10px] font-black uppercase tracking-tighter ${estado === "Asignado" ? "text-slate-800/60" : "text-slate-400"}`}>
                    {estado === "Asignado" ? "Solicitud Expirable" : "Pasajero a bordo"}
                  </p>
                  <p className="text-2xl font-black text-slate-900 leading-none">{pasajeroAsignado.name}</p>
                  
                  {estado === "Asignado" && (
                    <TimerBar duration={15000} onFinish={() => { toast.warn("Viaje expirado"); detenerSonido(); }} />
                  )}
                </div>
              </div>
            </div>

            <div className="h-72 rounded-[2.5rem] overflow-hidden border border-slate-800 bg-slate-800/30 backdrop-blur-sm">
                <ChatBox toEmail={pasajeroAsignado.email} userName={localStorage.getItem("userName") || "Taxista"} />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <div className="w-24 h-24 bg-slate-800/40 rounded-full flex items-center justify-center text-5xl mb-4 animate-bounce">🚕</div>
            <p className="text-white font-black text-xl uppercase italic tracking-tighter">Ciudad Valles</p>
            <p className="text-slate-500 text-[10px] font-bold uppercase tracking-[0.2em]">Esperando nueva señal...</p>
          </div>
        )}
      </div>

      {/* BOTONERA FIJA */}
      <div className="p-6 bg-slate-900/90 backdrop-blur-xl border-t border-white/5">
        {estado === "Asignado" && (
          <div className="grid grid-cols-2 gap-4">
            <button onClick={aceptarViaje} className="py-6 bg-green-500 text-white rounded-[2rem] font-black text-sm uppercase shadow-lg shadow-green-500/20 active:scale-90 transition-all">Aceptar</button>
            <button onClick={rechazarViaje} className="py-6 bg-slate-800 text-slate-400 rounded-[2rem] font-black text-sm uppercase active:scale-90 transition-all">Ignorar</button>
          </div>
        )}
        
        {estado === "EnCamino" && (
          <button onClick={confirmarAbordo} className="w-full py-6 bg-yellow-400 text-slate-900 rounded-[2rem] font-black text-xl uppercase shadow-xl shadow-yellow-400/20 active:scale-95 transition-all">
            Llegué al punto 📍
          </button>
        )}

        {estado === "EnCurso" && (
          <button onClick={finalizarViaje} className="w-full py-6 bg-red-600 text-white rounded-[2rem] font-black text-xl uppercase shadow-xl shadow-red-600/20 active:scale-95 transition-all">
            Terminar Viaje ✅
          </button>
        )}
      </div>
    </div>
  );
};

export default TaxistaView;