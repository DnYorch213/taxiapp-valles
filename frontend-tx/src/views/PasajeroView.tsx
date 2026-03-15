import React, { useState, useEffect } from "react";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { socket } from "../lib/socket";
import { useTravel } from "../context/TravelContext";
import { useGeolocation } from "../hooks/useGeolocation";
import { Payload } from "../types/Payload";
import { ChatBox } from "../components/ChatBox";

const PasajeroView: React.FC = () => {
  const { userPosition, setUserPosition } = useTravel();
// Esto permite los estados de Payload + tus nuevos estados
const [estado, setEstado] = useState<Payload['estado'] | "En Camino" | "En Curso">("Inactivo");  const [taxistaAsignado, setTaxistaAsignado] = useState<Payload | null>(null);

  // 1. GPS
  useGeolocation(
    {
      email: userPosition?.email || "",
      name: userPosition?.name || "Pasajero",
      role: "pasajero",
    },
    (pos) => {
      setUserPosition({ ...userPosition, lat: pos.lat, lng: pos.lng } as any);
    }
  );

  // 2. Escucha de Eventos Socket
  useEffect(() => {
    if (!socket) return;

    socket.on("taxista_asignado", (data: any) => {
      setTaxistaAsignado(data);
      setEstado("Asignado" as any);
      toast.success(`Taxi ${data.taxiNumber || ''} en camino`);
    });

    socket.on("response_from_taxi", ({ accepted }) => {
      if (accepted) {
        setEstado("En Camino" as any);
        toast.info("El taxista ha iniciado el trayecto");
      } else {
        setEstado("Inactivo");
        setTaxistaAsignado(null);
        toast.warn("Reasignando taxista...");
      }
    });

    // Escuchar cuando el taxista presiona "Servicio Abordo"
  socket.on("trip_status_update", (data: { status: string }) => {
    if (data.status === "en curso") {
      // Aquí actualizas tu estado local del pasajero
      setEstado("En Curso"); 
      toast.success("¡Viaje iniciado! Que tengas un buen trayecto.", {
        position: "top-center",
      });
    }
  });

    // ✅ Sincronización de finalización
    socket.on("trip_finished", (data: { pasajeroEmail: string }) => {
      if (data.pasajeroEmail === userPosition?.email) {
        setTaxistaAsignado(null);
        setEstado("Inactivo"); // Esto reactiva el botón
        toast.success("¡Has llegado a tu destino!");
      }
    });

    return () => {
      socket.off("taxista_asignado");
      socket.off("response_from_taxi");
      socket.off("trip_status_update");
      socket.off("trip_finished");
    };
  }, [socket, userPosition?.email]);

  // 3. Heartbeat
  useEffect(() => {
    if (!userPosition?.email || !userPosition?.lat) return;
    const interval = setInterval(() => {
      socket.emit("position", {
        ...userPosition,
        role: "pasajero",
        estado: estado.toLowerCase()
      });
    }, 10000);
    return () => clearInterval(interval);
  }, [userPosition, estado]);

  const solicitarTaxi = () => {
    if (!userPosition?.lat || userPosition.lat === 0) {
      toast.error("📍 Esperando señal GPS...");
      return;
    }
    const payload: Payload = {
      email: userPosition.email,
      name: userPosition.name,
      lat: userPosition.lat,
      lng: userPosition.lng,
      role: "pasajero",
      estado: "esperando",
      timestamp: new Date().toISOString(),
    };
    socket.emit("request_taxi", payload);
    setEstado("Buscando" as any);
    toast.info("Solicitud enviada");
  };

  const cancelarSolicitud = () => {
    socket.emit("passenger_cancel", {
      pasajeroEmail: userPosition?.email,
      taxistaEmail: taxistaAsignado?.email,
    });
    setEstado("Inactivo");
    setTaxistaAsignado(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center p-4">
      <ToastContainer />
      <header className="w-full max-w-md flex justify-between items-center py-6">
        <h1 className="text-2xl font-black text-slate-800 tracking-tighter">APP<span className="text-yellow-500">PASAJERO</span></h1>
      </header>

      <main className="w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden border border-slate-100">
        <div className="h-40 bg-slate-100 flex items-center justify-center relative">
          <div className="z-10 bg-white/90 px-4 py-2 rounded-full shadow-sm">
            <span className="text-xs font-bold text-slate-500">📍 GPS ACTIVO</span>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-slate-700">Estado</h2>
            <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${
              estado === 'Inactivo' ? 'bg-slate-100 text-slate-400' : 'bg-green-100 text-green-600 animate-pulse'
            }`}>
              {estado}
            </span>
          </div>
          
          {taxistaAsignado && (
            <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100 mb-6">
              <div className="h-12 w-12 bg-yellow-300 rounded-xl flex items-center justify-center text-xl">🚖</div>
              <div>
                <p className="text-xs font-normal text-slate-700">Taxista Asignado</p>
                <p className="text-sm font-bold text-slate-800">{taxistaAsignado.name}</p>
                <p className="text-xl text-slate-500 font-bold">Taxi {taxistaAsignado.taxiNumber}</p>
              </div>
            </div>
          )}

          <div className="space-y-3">
            <button
              onClick={solicitarTaxi}
              // ✅ CORRECCIÓN: Usamos el estado real para deshabilitar
              disabled={estado !== "Inactivo"}
              className={`w-full py-4 rounded-2xl font-bold transition-all transform active:scale-95 shadow-xl ${
                estado === "Inactivo" 
                ? "bg-slate-900 text-white" 
                : "bg-slate-200 text-slate-400 cursor-not-allowed opacity-70 shadow-none"
              }`}
            >
              {estado === "Inactivo" ? "SOLICITAR TAXI AHORA" : "VIAJE EN CURSO"}
            </button>
            
            {estado !== "Inactivo" && (
              <button onClick={cancelarSolicitud} className="w-full py-3 text-slate-400 hover:text-red-500 text-sm">
                Cancelar solicitud
              </button>
            )}
          </div>
        </div>
      </main>

      {/* ✅ ChatBox dinámico */}
      {taxistaAsignado && taxistaAsignado.email && (
        <div className="w-full max-w-md mt-6 p-4 border border-slate-200 rounded-2xl bg-white shadow-lg animate-in slide-in-from-bottom-2">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Chat con Taxista</h3>
          </div>
          <div className="rounded-lg border border-slate-50 overflow-hidden">
            <ChatBox toEmail={taxistaAsignado.email} userName={userPosition?.name || "Pasajero"} />
          </div>
        </div>
      )}
    </div>
  );
};

export default PasajeroView;