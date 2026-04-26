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
  const [estado, setEstado] = useState<"disponible" | "asignado" | "encurso" | "encamino">("disponible");
  const [pasajeroAsignado, setPasajeroAsignado] = useState<Payload | null>(null);
  const [excludedEmails, setExcludedEmails] = useState<string[]>([]);
  const [chatAbierto, setChatAbierto] = useState(false);
  
  // 🚩 ESTADO PARA EL RASTRO DEL VIAJE
  const [historialRuta, setHistorialRuta] = useState<L.LatLngExpression[]>([]);
  
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const estadoRef = useRef(estado);

 // --- 🔔 FUNCIÓN DE SUSCRIPCIÓN (SÁCADA DEL USEEFFECT) ---
  const gestionarSuscripcion = async () => {
    const userEmail = userPosition?.email || localStorage.getItem("email");

    if (!userEmail) {
      alert("No se encontró el email del usuario");
      return;
    }

    try {
      // 1. Verificar si el navegador soporta Service Workers
      if (!('serviceWorker' in navigator)) {
        alert("Tu navegador no soporta notificaciones");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      
      // 2. Intentar suscribir
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });

      if (subscription) {
        console.log(`Enviando suscripción para: ${userEmail}`);
        await axios.post(`${API_URL}/save-subscription`, {
          email: userEmail,
          subscription: subscription
        });
        //alert("✅ ¡Notificaciones activadas con éxito!");
      }
    } catch (err: any) {
      console.error("Error gestionando suscripción:", err);
      alert("Error al activar: " + err.message);
    }
  };

  useEffect(() => { 
    estadoRef.current = estado; 
  }, [estado]);

  // Este useEffect ahora solo llama a la función que ya existe arriba
  useEffect(() => {
    if (userPosition?.email || localStorage.getItem("email")) {
      gestionarSuscripcion();
    }
  }, [userPosition?.email]);

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
    if (pos.lat === null || pos.lng === null) return;

    // 1. Actualización local
    if (userPosition) {
      setUserPosition({ ...userPosition, lat: pos.lat, lng: pos.lng });
    }

    const estadoActual = estadoRef.current;
    
    // 2. Envío al socket con LÓGICA EXCLUSIVA
    if (socket && (estadoActual === "asignado" || estadoActual === "encamino" || estadoActual === "encurso")) {
      
      if (estadoActual === "encurso") {
        // --- MODO VIAJE: Solo emitimos el rastro ---
        const nuevaCoord: L.LatLngExpression = [pos.lat, pos.lng];
        setHistorialRuta((prev) => [...prev, nuevaCoord]);
        
        socket.emit("update_trip_path", {
          pasajeroEmail: pasajeroAsignado?.email,
          lat: pos.lat,
          lng: pos.lng
        });
      } else {
        // --- MODO APROXIMACIÓN (Asignado/EnCamino): Emitimos movimiento normal ---
        socket.emit("taxi_moved", {
          lat: pos.lat,
          lng: pos.lng,
          email: userPosition?.email || localStorage.getItem("email"),
          taxiNumber: userPosition?.taxiNumber || localStorage.getItem("taxiNumber"),
          role: "taxista"
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
  console.log("📩 Nueva asignación recibida:", data);

  // 1. EXTRACCIÓN Y LIMPIEZA: Manejamos si viene de Mongoose (_doc) o es objeto plano
  const rawData = data._doc ? data._doc : data;
  
  // Validamos que el email exista para evitar el error de "undefined" al aceptar
  if (!rawData.email) {
    console.error("❌ Error crítico: Los datos recibidos no tienen email", data);
    return;
  }

  // Limpieza de estado previa para asegurar un render limpio
  setPasajeroAsignado(null);

  setTimeout(() => {
    // 2. ACTUALIZACIÓN DE ESTADOS
    // Limpiamos el email por si trae la "k" extra o espacios
    const pEmail = rawData.email.toLowerCase().trim();
    setPasajeroAsignado({ ...rawData, email: pEmail, attempt: data.attempt });
    setExcludedEmails(data.excludedEmails || []);
    
    const estadoServidor = rawData.estado?.toLowerCase().trim();

    // 3. LÓGICA DE FLUJO (Diferenciando Oferta Nueva vs Viaje Activo)
    
    if (data.isNewOffer) {
      /**
       * CASO A: Oferta Nueva (Viene del salto de Jorge o solicitud inicial)
       * Forzamos estado "Asignado" para que React muestre el botón de ACEPTAR.
       */
      setEstado("asignado"); 
      reproducirAlerta();
    } 
    else if (estadoServidor === "encurso" || estadoServidor === "ocupado") {
      /**
       * CASO B: Viaje ya iniciado
       */
      setEstado("encurso");
      detenerSonido();
    } 
    else if (estadoServidor === "asignado") {
      /**
       * CASO C: Reconexión (El taxista ya había aceptado previamente)
       * Como no es 'isNewOffer', lo mandamos directo a la vista de navegación.
       */
      setEstado("encamino"); 
      detenerSonido();
    } 
    else {
      /**
       * CASO D: Backup de seguridad
       */
      setEstado("asignado"); 
      reproducirAlerta();
    }
  }, 10);
}, [detenerSonido, reproducirAlerta]);

  useEffect(() => {
    if (!socket) return;

    socket.on("pasajero_asignado", handleAsignacion);
    // 🚩 ESTO ES LO QUE FALTA: Escuchar la confirmación oficial
    socket.on("assignment_confirmed", (data) => {
      console.log("✅ Confirmación recibida del servidor:", data);
      if (data.success) {
        setEstado("encamino"); // Ahora sí, cambiamos la vista
        detenerSonido();
        toast.success("¡Viaje vinculado! Dirígete al pasajero.");
        
        // Si el servidor mandó datos actualizados del pasajero, los guardamos
        if (data.pasajero) {
          const pEmail = data.pasajero.email.toLowerCase().trim();
          setPasajeroAsignado({ ...data.pasajero, email: pEmail });
        }
      }
    });
    socket.on("dispatch_timeout", () => {
      detenerSonido();
      setPasajeroAsignado(null);
      setEstado("disponible");
    });
    socket.on("trip_cancelled_by_passenger", () => {
      detenerSonido();
      setPasajeroAsignado(null);
      setEstado("disponible");
      setChatAbierto(false);
      setHistorialRuta([]); // Limpiar rastro
    });

    socket.on("trip_finished", () => {
      detenerSonido();
      setEstado("disponible");
      setPasajeroAsignado(null);
      setChatAbierto(false);
      setHistorialRuta([]); // Limpiar rastro
    });

    if (socket.connected) checkStatus();

    return () => {
      socket.off("pasajero_asignado");
      socket.off("assignment_confirmed");
      socket.off("dispatch_timeout");
      socket.off("trip_cancelled_by_passenger");
      socket.off("trip_finished");
    };
  }, [handleAsignacion, checkStatus, detenerSonido]);

 // --- ACCIONES DEL TAXISTA ---
const aceptarViaje = () => {
  if (!pasajeroAsignado?.email) {
    console.error("❌ Error: No hay email de pasajero para aceptar.");
    return;
  }
  detenerSonido();
  
  // Enviamos el email del pasajero tal cual lo recibimos del socket
  socket.emit("taxi_response", { 
    requestEmail: pasajeroAsignado.email.toLowerCase().trim(), 
    accepted: true, 
    excludedEmails 
  });
  
  setEstado("encamino");
};

const rechazarViaje = () => {
  if (!pasajeroAsignado?.email) return;
  detenerSonido();
  socket.emit("taxi_response", { 
    requestEmail: pasajeroAsignado.email.toLowerCase().trim(), 
    accepted: false, 
    excludedEmails 
  });
  setPasajeroAsignado(null);
  setEstado("disponible");
};

const confirmarAbordo = () => {
  const tEmail = userPosition?.email || localStorage.getItem("email");
  const pEmail = pasajeroAsignado?.email;

  if (!tEmail || !pEmail) {
    toast.error("Datos de viaje incompletos");
    return;
  }

  socket.emit("passenger_on_board", { 
    taxistaEmail: tEmail.toLowerCase().trim(), 
    pasajeroEmail: pEmail.toLowerCase().trim() 
  });

  setEstado("encurso");
  setChatAbierto(false);
  
  if (userPosition?.lat) {
    setHistorialRuta([[userPosition.lat, userPosition.lng!]]);
  }
};

const finalizarViaje = () => {
  const tEmail = userPosition?.email || localStorage.getItem("email");
  const pEmail = pasajeroAsignado?.email;

  if (!tEmail || !pEmail) {
    setEstado("disponible");
    setPasajeroAsignado(null);
    return;
  }

  socket.emit("end_trip", { 
    pasajeroEmail: pEmail.toLowerCase().trim(), 
    taxistaEmail: tEmail.toLowerCase().trim() 
  });

  setEstado("disponible");
  setPasajeroAsignado(null);
  setHistorialRuta([]); 
  toast.info("Servicio finalizado");
};

  // --- MAPA & RUTA ---
  const puntosRuta = useMemo(() => {
    // 🚩 Solo usamos RoutingMachine para ir a buscar al pasajero (EnCamino)
    if (estado === "encamino" && pasajeroAsignado?.lat && userPosition?.lat) {
      return [L.latLng(userPosition.lat!, userPosition.lng!), L.latLng(pasajeroAsignado.lat!, pasajeroAsignado.lng!)];
    }
    return [];
  }, [pasajeroAsignado, userPosition, estado]);

return (
  /* 1. Usamos h-dvh para control total del alto y bg oscuro de fondo */
  <div className="h-dvh bg-[#0f172a] flex flex-col overflow-hidden font-sans relative text-slate-100">
    <ToastContainer theme="dark" />

    {/* HEADER COMPACTO (Fijo arriba) */}
    <header className="w-full max-w-md mx-auto flex justify-between items-center py-3 px-6 shrink-0 bg-[#0f172a] z-[1002]">
      <h1 className="text-lg font-black text-white uppercase italic tracking-tighter">
        VALLES<span className="text-[#22c55e]">CONECTA</span>
      </h1>
      <div className="flex items-center gap-2 bg-[#1e293b] px-3 py-1 rounded-full border border-white/5">
        <div className={`h-1.5 w-1.5 rounded-full ${userPosition?.lat ? 'bg-[#22c55e]' : 'bg-red-500 animate-ping'}`}></div>
        <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">ECO-{userPosition?.taxiNumber || 'GPS'}</span>
      </div>
    </header>

    {/* 2. CONTENIDO PRINCIPAL (Mapa flexible) */}
    <main className="flex-1 w-full relative bg-[#1e293b]">
      {userPosition?.lat ? (
        <MapContainer 
          center={[userPosition.lat!, userPosition.lng!]} 
          zoom={15} 
          className="h-full w-full"
          zoomControl={false}
        >
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {puntosRuta.length > 0 && <RoutingMachine waypoints={puntosRuta} />}
          {estado === "encurso" && (
            <Polyline 
              positions={historialRuta} 
              pathOptions={{ color: '#22c55e', weight: 6, opacity: 0.8 }} 
            />
          )}
          <Marker position={[userPosition.lat!, userPosition.lng!]} icon={taxistaIcon} />
          {pasajeroAsignado?.lat && estado !== "encurso" && (
            <Marker position={[pasajeroAsignado.lat!, pasajeroAsignado.lng!]} icon={pasajeroIcon} />
          )}
        </MapContainer>
      ) : (
        <div className="h-full w-full flex items-center justify-center text-slate-500 text-[10px] font-black uppercase italic animate-pulse">
          🛰️ Sincronizando GPS Valles...
        </div>
      )}

      {/* Badge de estado flotante sobre el mapa */}
      <div className="absolute top-4 left-4 z-[1000] bg-[#1e293b]/90 backdrop-blur-md px-4 py-2 rounded-2xl shadow-2xl border border-white/10 flex items-center gap-3">
        <div className={`h-2.5 w-2.5 rounded-full ${estado === "disponible" ? "bg-[#22c55e]" : "bg-orange-500 animate-ping"}`}></div>
        <span className="text-[11px] font-black text-white uppercase tracking-widest">{estado}</span>
      </div>
    </main>

    {/* 3. PANEL DE ACCIONES (Chat + Controles) */}
    <div className="w-full max-w-md mx-auto bg-[#1e293b] rounded-t-[2.5rem] shadow-[0_-25px_60px_rgba(0,0,0,0.5)] shrink-0 z-[1001] relative border-t border-white/5">
      <div className="absolute top-3 left-1/2 -translate-x-1/2 w-12 h-1 bg-slate-700 rounded-full"></div>

      {pasajeroAsignado ? (
        <div className="flex flex-col">
          {/* INFO DEL PASAJERO */}
          <div className="px-6 pt-8 pb-4">
            <div className={`p-4 rounded-[2rem] transition-all duration-500 ${estado === "asignado" ? "bg-[#22c55e]" : "bg-[#0f172a]/50 border border-white/5"}`}>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-white flex items-center justify-center text-2xl shadow-lg">👤</div>
                <div className="flex-1">
                  <p className={`text-[8px] font-black uppercase tracking-[0.2em] ${estado === "asignado" ? "text-[#0f172a]/60" : "text-slate-500"}`}>
                    {estado === "encurso" ? "Viaje Activo" : "Solicitud Entrante"}
                  </p>
                  <h3 className={`text-lg font-black leading-tight ${estado === "asignado" ? "text-[#0f172a]" : "text-white"}`}>
                    {pasajeroAsignado.name}
                  </h3>
                  {estado === "asignado" && <TimerBar duration={15000} onFinish={rechazarViaje} />}
                </div>
              </div>
            </div>
          </div>

          {/* CHAT INTEGRADO: Solo si ya aceptó el viaje y no ha finalizado */}
          {(estado === "encamino") && (
            <div className="border-y border-white/5 bg-[#0f172a]/30">
              <div 
                onClick={() => setChatAbierto(!chatAbierto)}
                className="h-[55px] flex items-center justify-between px-8 cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <div className="h-2 w-2 rounded-full bg-[#22c55e] animate-pulse"></div>
                  <span className="text-[10px] font-black text-white uppercase tracking-widest">Chat con Pasajero</span>
                </div>
                <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  {chatAbierto ? 'Cerrar' : 'Escribir'}
                </span>
              </div>
              <div className={`transition-all duration-500 overflow-hidden ${chatAbierto ? "h-[300px]" : "h-0"}`}>
                <ChatBox toEmail={pasajeroAsignado.email} userName={`Taxi Valles`} />
              </div>
            </div>
          )}

          {/* BOTONES DE ACCIÓN */}
          <div className="p-6 pb-10">
            {estado === "asignado" && (
              <div className="grid grid-cols-5 gap-3">
                <button onClick={aceptarViaje} className="col-span-3 py-5 bg-[#22c55e] text-[#0f172a] rounded-2xl font-black text-lg active:scale-95 transition-transform shadow-xl shadow-green-900/20">
                  ACEPTAR
                </button>
                <button onClick={rechazarViaje} className="col-span-2 py-5 bg-slate-800 text-slate-400 rounded-2xl font-black text-[10px] uppercase tracking-widest">
                  Ignorar
                </button>
              </div>
            )}

            {estado === "encamino" && (
              <button onClick={confirmarAbordo} className="w-full py-5 bg-white text-[#0f172a] rounded-2xl font-black text-lg flex items-center justify-center gap-3 border-b-4 border-slate-300 active:translate-y-1 transition-all">
                📍 CONFIRMAR ABORDO
              </button>
            )}

            {estado === "encurso" && (
              <button onClick={finalizarViaje} className="w-full py-5 bg-red-600 text-white rounded-2xl font-black text-lg border-b-4 border-red-900 shadow-xl active:translate-y-1 transition-all">
                🏁 FINALIZAR SERVICIO
              </button>
            )}
          </div>
        </div>
      ) : (
        /* ESTADO BUSCANDO */
        <div className="py-12 flex flex-col items-center justify-center">
          <div className="w-16 h-16 bg-[#0f172a] border-4 border-[#22c55e] rounded-[2rem] flex items-center justify-center text-3xl mb-4 shadow-2xl animate-bounce">🚕</div>
          <h2 className="text-xl font-black text-white uppercase italic tracking-tighter">VALLES<span className="text-[#22c55e]">CONECTA</span></h2>
          <p className="text-slate-500 text-[10px] font-bold uppercase tracking-[0.2em] mt-1 animate-pulse">Esperando señal de viaje...</p>
        </div>
      )}
    </div>
  </div>
);
};

export default TaxistaView;