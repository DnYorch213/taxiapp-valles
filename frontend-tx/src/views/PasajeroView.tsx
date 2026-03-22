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
  
  // Estados extendidos para un flujo de viaje completo
  const [estado, setEstado] = useState<Payload['estado'] | "EnCamino" | "EnCurso" | "Finalizado" | "Buscando">("Inactivo");
  const [taxistaAsignado, setTaxistaAsignado] = useState<Payload | null>(null);
  const [chatAbierto, setChatAbierto] = useState(false);
  // 1. GPS Hook
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
      setEstado("Asignado");
      toast.success(`Taxi ${data.taxiNumber || ''} asignado`);
    });

    socket.on("response_from_taxi", ({ accepted }) => {
      if (accepted) {
        setEstado("EnCamino");
        toast.info("El taxista va hacia tu ubicación");
      } else {
        setEstado("Inactivo");
        setTaxistaAsignado(null);
        toast.warn("Buscando otro taxista...");
      }
    });

    socket.on("taxi_rejected_request", () => {
    // Al limpiar esto, el pasajero deja de ver la card del taxista anterior
    // y vuelve a ver el estado de "Buscando unidad..."
    setTaxistaAsignado(null); 
    setEstado("Buscando"); 
    toast.info("Buscando otra unidad cercana...");
  });

    socket.on("trip_status_update", (data: { status: string }) => {
      if (data.status === "en curso") {
        setEstado("EnCurso"); 
        toast.success("¡Viaje iniciado! Que tengas un buen trayecto.", { position: "top-center" });
      }
    });

    socket.on("trip_finished", (data: { pasajeroEmail: string }) => {
      if (data.pasajeroEmail === userPosition?.email) {
        setEstado("Finalizado"); // Dispara la pantalla de agradecimiento
      }
    });

    return () => {
      socket.off("taxista_asignado");
      socket.off("response_from_taxi");
      socket.off("taxi_rejected_request");
      socket.off("trip_status_update");
      socket.off("trip_finished");
    };
  }, [socket, userPosition?.email]);

  // 3. Heartbeat (Sincronización con el mapa de Admin/Taxi)
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
    setEstado("Buscando");
    toast.info("Buscando unidades cercanas...");
  };

  const cancelarSolicitud = () => {
    socket.emit("passenger_cancel", {
      pasajeroEmail: userPosition?.email,
      taxistaEmail: taxistaAsignado?.email,
    });
    setEstado("Inactivo");
    setTaxistaAsignado(null);
  };

  const resetearApp = () => {
    setEstado("Inactivo");
    setTaxistaAsignado(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center p-4 font-sans relative overflow-hidden">
      <ToastContainer theme="light" />
      
      {/* Franja decorativa superior */}
      <div className="absolute top-0 left-0 w-full h-2 bg-[#22c55e]"></div>

      <header className="w-full max-w-md flex justify-between items-center py-8">
        <h1 className="text-2xl font-black text-slate-800 tracking-tighter uppercase italic">
          VALLES<span className="text-[#22c55e]">VIAJE</span>
        </h1>
        <div className="flex items-center gap-2 bg-white px-3 py-1 rounded-full border border-slate-200 shadow-sm">
          <div className={`h-2 w-2 rounded-full ${userPosition?.lat ? 'bg-[#22c55e]' : 'bg-red-500'}`}></div>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">GPS Activo</span>
        </div>
      </header>

      <main className="w-full max-w-md bg-white rounded-[2.5rem] shadow-2xl overflow-hidden border border-slate-100 relative">
       {/* 🟢 ILUSTRACIÓN DINÁMICA MEJORADA */}
<div className="h-44 bg-slate-50 flex items-center justify-center relative overflow-hidden rounded-t-[2.5rem]">
  {/* Decoración de fondo: Un taxi grande y desvanecido */}
  <div className="text-8xl opacity-[0.03] absolute -right-6 -bottom-6 rotate-12 select-none">
    🚕
  </div>

  {/* Contenedor del Icono Principal */}
  <div className={`z-10 bg-white border-2 p-6 rounded-[2rem] shadow-2xl transform transition-all duration-700 ease-out ${
    estado === 'EnCurso' 
      ? 'rotate-0 scale-125 border-[#22c55e] shadow-green-100' 
      : 'rotate-[-4deg] scale-100 border-slate-100'
  }`}>
    
    <div className="relative flex items-center justify-center">
      {/* Efecto de ondas cuando el viaje está en curso */}
      {estado === 'EnCurso' && (
        <div className="absolute inset-0 bg-[#22c55e]/20 rounded-full animate-ping scale-150"></div>
      )}

      {/* ICONO DINÁMICO: Palomita Verde o Pin de Ubicación */}
      {estado === 'EnCurso' ? (
        <div className="text-[#22c55e] animate-in zoom-in duration-500 relative z-10">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
      ) : (
        <span className={`text-5xl relative z-10 ${estado !== 'Inactivo' ? 'animate-bounce' : 'grayscale opacity-50'}`}>
          📍
        </span>
      )}
    </div>
  </div>

  {/* Pequeño indicador de "Ruta Activa" solo en EnCurso */}
  {estado === 'EnCurso' && (
    <div className="absolute bottom-4 flex gap-1">
      <div className="h-1.5 w-1.5 bg-[#22c55e] rounded-full animate-pulse"></div>
      <div className="h-1.5 w-1.5 bg-[#22c55e]/40 rounded-full animate-pulse delay-75"></div>
      <div className="h-1.5 w-1.5 bg-[#22c55e]/20 rounded-full animate-pulse delay-150"></div>
    </div>
  )}
</div>

        {/* CONTENEDOR DE ESTADOS (REFRACTORIZADO) */}
        <div className="p-8">
          <div className="flex items-center justify-between mb-8">
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Servicio Valles</p>
              <h2 className="text-2xl font-black text-slate-800 tracking-tighter leading-none transition-all duration-500">
                {estado === 'Inactivo' && "¿A dónde vamos?"}
                {estado === 'Buscando' && "Buscando unidad..."}
                {estado === 'Asignado' && "¡Unidad confirmada!"}
                {estado === 'EnCamino' && "Tu taxi viene en camino"}
                {estado === 'EnCurso' && "¡Buen viaje por Valles!"}
              </h2>
            </div>

            <div className={`px-4 py-2 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 shadow-lg transition-colors ${
              estado === 'Inactivo' ? 'bg-slate-100 text-slate-400 shadow-none' : 'bg-[#22c55e] text-white animate-pulse shadow-green-200'
            }`}>
              <div className={`h-1.5 w-1.5 rounded-full ${estado === 'Inactivo' ? 'bg-slate-300' : 'bg-white'}`}></div>
              {estado === 'EnCurso' ? 'A BORDO' : estado}
            </div>
          </div>

          {/* CARD DEL TAXISTA DINÁMICA */}
          {taxistaAsignado && (
            <div className="p-5 bg-green-50 border-2 border-green-100 rounded-[2.5rem] flex items-center gap-4 animate-in slide-in-from-bottom-4 mb-8">
              <div className="h-14 w-14 bg-white rounded-2xl flex items-center justify-center text-2xl shadow-sm">
                {estado === 'EnCurso' ? '⭐' : '🚖'}
              </div>
              <div className="flex-1">
                <p className="text-[10px] font-black text-green-600 uppercase tracking-widest">
                  {estado === 'EnCurso' ? 'Viaje Iniciado' : 'Datos del Taxista'}
                </p>
                <p className="text-lg font-black text-slate-800">Tx-{taxistaAsignado.taxiNumber}</p>
                <p className="text-[10px] font-bold text-slate-400 uppercase truncate max-w-[120px]">{taxistaAsignado.name}</p>
              </div>
              {estado === 'EnCamino' && (
                 <div className="bg-green-500 text-white text-[8px] font-black px-2 py-1 rounded-lg animate-bounce">Cerca</div>
              )}
            </div>
          )}

          <div className="space-y-4">
            <button
              onClick={solicitarTaxi}
              disabled={estado !== "Inactivo"}
              className={`w-full py-5 rounded-[1.8rem] font-black transition-all transform active:scale-95 shadow-2xl tracking-widest text-sm ${
                estado === "Inactivo" 
                ? "bg-[#22c55e] text-white hover:bg-[#16a34a] shadow-green-900/20" 
                : "bg-slate-100 text-slate-300 cursor-not-allowed shadow-none"
              }`}
            >
              {estado === "Inactivo" ? "SOLICITAR TRANSPORTE" : "VIAJE ACTIVO"}
            </button>
            
            {(estado === "Buscando" || estado === "Asignado" || estado === "EnCamino") && (
              <button 
                  onClick={cancelarSolicitud} 
                  className="w-full py-2 text-slate-400 hover:text-red-500 text-[10px] font-black uppercase tracking-[0.2em] transition-colors"
              >
                Cancelar Servicio
              </button>
            )}
          </div>
        </div>
      </main>

      {/* 💬 CHAT COLAPSABLE CORREGIDO */}
{taxistaAsignado && taxistaAsignado.email && estado === 'EnCamino' && (
  <div 
    className={`fixed bottom-0 left-0 w-full z-[2000] transition-all duration-500 ease-in-out ${
      chatAbierto ? "translate-y-0" : "translate-y-[calc(100%-70px)]"
    }`}
  >
    <div className="max-w-md mx-auto bg-white rounded-t-[2.5rem] shadow-[0_-20px_50px_rgba(0,0,0,0.2)] border-x border-t border-slate-100 overflow-hidden">
      
      {/* 🟢 CABECERA / BOTÓN DESPLEGABLE (Siempre visible) */}
      <div 
        onClick={() => setChatAbierto(!chatAbierto)}
        className="h-[70px] flex items-center justify-between px-8 cursor-pointer bg-white active:bg-slate-50 transition-colors border-b border-slate-50"
      >
        <div className="flex items-center gap-4">
          <div className="relative h-10 w-10 bg-green-50 rounded-2xl flex items-center justify-center text-xl shadow-sm">
            💬
            {/* Punto de notificación */}
            <div className="absolute -top-1 -right-1 h-3 w-3 bg-[#22c55e] border-2 border-white rounded-full animate-ping"></div>
          </div>
          <div>
            <h3 className="text-[11px] font-black text-slate-800 uppercase tracking-[0.2em]">
              Chat con la Unidad
            </h3>
            <p className="text-[9px] font-bold text-green-500 uppercase tracking-widest">
              {chatAbierto ? "Cerrar ventana" : "Toca para escribir"}
            </p>
          </div>
        </div>
        
        {/* Flecha indicadora */}
        <div className={`p-2 rounded-full bg-slate-50 transform transition-transform duration-500 ${chatAbierto ? "rotate-180" : "rotate-0"}`}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15"></polyline>
          </svg>
        </div>
      </div>

      {/* 🟢 CUERPO DEL CHAT (Se oculta al colapsar) */}
      <div className="h-[450px] bg-white">
        <ChatBox 
          toEmail={taxistaAsignado.email} 
          userName={userPosition?.name || "Pasajero"} 
        />
      </div>
    </div>
  </div>
)}

      {/* FOOTER */}
      <div className="mt-auto py-6 opacity-30">
         <p className="text-[10px] font-black text-slate-400 tracking-[0.5em] uppercase">Ciudad Valles SLP</p>
      </div>

      {/* 🌟 PANTALLA DE FINALIZACIÓN */}
      {estado === 'Finalizado' && (
        <div className="fixed inset-0 z-[2000] bg-[#22c55e] flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in duration-500">
          <div className="bg-white rounded-[3rem] p-10 shadow-2xl flex flex-col items-center text-center max-w-sm w-full">
            <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center text-4xl mb-6 border-2 border-green-100">🚕</div>
            <h2 className="text-3xl font-black text-slate-800 tracking-tighter leading-none mb-4 uppercase">¡Gracias por tu preferencia!</h2>
            <p className="text-slate-400 font-bold text-sm leading-relaxed mb-8 uppercase tracking-widest">Esperamos que hayas tenido un excelente viaje.</p>
            <button 
              onClick={resetearApp} 
              className="w-full py-5 bg-[#22c55e] hover:bg-[#16a34a] text-white rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-green-200 transition-all"
            >
              Aceptar
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PasajeroView;