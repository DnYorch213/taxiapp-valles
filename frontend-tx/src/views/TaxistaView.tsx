import React, { useState, useEffect } from "react";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { socket } from "../lib/socket";
import { useTravel } from "../context/TravelContext";
import { useGeolocation } from "../hooks/useGeolocation";
import { Payload } from "../types/Payload";
import { ChatBox } from "../components/ChatBox";

const TaxistaView: React.FC = () => {
  const { userPosition, setUserPosition } = useTravel();
  const [estado, setEstado] = useState<"Disponible" | "Asignado" | "EnCurso" | "EnCamino" | "ocupado">("Disponible");
  const [pasajeroAsignado, setPasajeroAsignado] = useState<Payload | null>(null);
  
  // 🚀 NUEVO ESTADO: Para no perder la cadena de taxistas que rechazaron
  const [excludedEmails, setExcludedEmails] = useState<string[]>([]);

  // 1. GPS: Sincronización constante
  useGeolocation(
    {
      email: userPosition?.email || localStorage.getItem("email") || "",
      name: localStorage.getItem("userName") || userPosition?.name || "Taxista",
      role: "taxista",
      taxiNumber: userPosition?.taxiNumber || localStorage.getItem("taxiNumber") || "",
    },
    (pos) => {
      if (userPosition) {
        setUserPosition({ 
          ...userPosition, 
          lat: pos.lat, 
          lng: pos.lng 
        });
      }
    }
  );

  // 2. Gestión de Sockets
  useEffect(() => {
    if (!socket) return;

    socket.on("pasajero_asignado", (data: Payload & { excludedEmails?: string[] }) => {
      setPasajeroAsignado(data);
      // 📥 Guardamos los correos que el servidor ya intentó contactar
      setExcludedEmails(data.excludedEmails || []);
      setEstado("Asignado");
      toast.info(`¡Nuevo servicio: ${data.name}!`, { position: "top-center" });
      if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]);
    });    

    socket.on("trip_cancelled_by_passenger", (data: any) => {
      setPasajeroAsignado(null);
      setEstado("Disponible");
      setExcludedEmails([]);
      toast.error(data.message || "El pasajero ha cancelado el viaje", { position: "top-center" });
    });

    return () => {
      socket.off("pasajero_asignado");
      socket.off("trip_cancelled_by_passenger");
    };
  }, [socket]);

  // 3. ACCIONES REFACTORIZADAS

  const aceptarViaje = () => {
    if (!pasajeroAsignado || !userPosition?.lat) return;

    socket.emit("taxi_response", { 
      requestEmail: pasajeroAsignado.email, 
      accepted: true,
      excludedEmails: excludedEmails // Enviamos la lista actual
    });

    setEstado("EnCamino"); 
    setExcludedEmails([]); // Limpiamos la lista local

    const origin = `${userPosition.lat},${userPosition.lng}`;
    const destination = `${pasajeroAsignado.lat},${pasajeroAsignado.lng}`;
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
    window.open(url, "_blank");
  };

  // 🚀 NUEVA FUNCIÓN: Rechazar activa la cascada en el servidor de inmediato
  const rechazarViaje = () => {
    if (!pasajeroAsignado) return;

    socket.emit("taxi_response", { 
      requestEmail: pasajeroAsignado.email, 
      accepted: false,
      excludedEmails: excludedEmails // Devolvemos la lista para que el server sume a este taxista
    });

    setPasajeroAsignado(null);
    setEstado("Disponible");
    setExcludedEmails([]);
    toast.warn("Servicio rechazado. Buscando otro para el pasajero...");
  };

  const confirmarAbordo = () => {
    if (!pasajeroAsignado) return;
    socket.emit("passenger_on_board", {
      taxistaEmail: userPosition?.email,
      pasajeroEmail: pasajeroAsignado.email
    });
    setEstado("EnCurso");
  };

  const finalizarViaje = () => {
    if (!pasajeroAsignado) return;
    socket.emit("end_trip", {
      pasajeroEmail: pasajeroAsignado.email,
      taxistaEmail: userPosition?.email
    });
    setEstado("Disponible");
    setPasajeroAsignado(null);
  };

  return (
    <div className="min-h-screen bg-slate-900 p-4 flex flex-col font-sans">
      <ToastContainer theme="dark" />
      
      {/* HEADER STATUS */}
      <div className="flex justify-between items-center mb-6">
        <span className="text-white font-black tracking-widest text-lg">
          APP<span className="text-yellow-400">TAXISTA</span>
        </span>
        <div className="flex items-center gap-2">
          <div className={`h-3 w-3 rounded-full ${userPosition?.lat ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
          <span className="text-[10px] text-slate-400 font-bold uppercase">
            {userPosition?.lat ? 'GPS ONLINE' : 'BUSCANDO GPS...'}
          </span>
        </div>
      </div>

      {/* ÁREA CENTRAL */}
      <div className="flex-1 flex flex-col justify-center">
        {pasajeroAsignado ? (
          <div className={`rounded-3xl p-6 shadow-2xl transition-all duration-500 ${estado === "Asignado" ? "bg-yellow-400" : "bg-white"}`}>
            <h3 className="font-black text-2xl mb-1 text-slate-900">
              {estado === "Asignado" ? "¡NUEVA SOLICITUD!" : "VIAJE EN CURSO"}
            </h3>
            
            <div className="bg-slate-900/10 p-4 rounded-2xl flex items-center gap-4 mt-4">
              <div className="w-12 h-12 bg-slate-900 rounded-full flex items-center justify-center text-xl text-white">👤</div>
              <div>
                <p className="text-[10px] font-bold text-slate-500 uppercase">Pasajero</p>
                <p className="text-lg font-black text-slate-900">{pasajeroAsignado.name}</p>
              </div>
            </div>

            <div className="mt-6 border-t border-black/10 pt-4">
               <ChatBox 
                  toEmail={pasajeroAsignado.email} 
                  userName={localStorage.getItem("userName") || userPosition?.name || "Taxista"} 
                />
            </div>
          </div>
        ) : (
          <div className="bg-slate-800 rounded-3xl p-10 text-center border border-slate-700 shadow-inner">
            <div className="text-5xl mb-4">⌛</div>
            <p className="text-white font-black text-xl mb-1 uppercase">Disponible</p>
            <p className="text-slate-500 text-sm">Esperando reportes en tu zona...</p>
          </div>
        )}
      </div>

      {/* BOTONES ACCIONABLES */}
      <div className="mt-8 space-y-3">
        {estado === "Asignado" && (
          <div className="flex flex-col gap-3">
            <button onClick={aceptarViaje} className="w-full py-6 bg-green-500 text-white rounded-[2rem] font-black text-2xl shadow-xl active:scale-95 transition-all">
              ACEPTAR SERVICIO
            </button>
            <button onClick={rechazarViaje} className="w-full py-4 bg-slate-700 text-slate-300 rounded-[2rem] font-bold text-lg active:scale-95 transition-all">
              RECHAZAR
            </button>
          </div>
        )}
        
        {estado === "EnCamino" && (
          <button onClick={confirmarAbordo} className="w-full py-6 bg-yellow-400 text-slate-900 rounded-[2rem] font-black text-2xl shadow-xl active:scale-95 transition-all">
            PASAJERO ABORDO 👤
          </button>
        )}

        {estado === "EnCurso" && (
          <button onClick={finalizarViaje} className="w-full py-6 bg-white text-red-600 rounded-[2rem] font-black text-2xl shadow-xl active:scale-95 transition-all border-b-8 border-slate-200">
            FINALIZAR VIAJE
          </button>
        )}
      </div>
    </div>
  );
};

export default TaxistaView;