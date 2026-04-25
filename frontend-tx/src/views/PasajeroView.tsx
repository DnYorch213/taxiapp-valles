import React, { useState, useEffect, useMemo, useRef } from "react";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { socket } from "../lib/socket";
import { useTravel } from "../context/TravelContext";
import { useGeolocation } from "../hooks/useGeolocation";
import { Payload } from "../types/Payload";
import { ChatBox } from "../components/ChatBox";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet"; // 🚩 Importamos Polyline
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { RoutingMachine } from "../components/RoutingMachine";
import { taxistaIcon, pasajeroIcon } from "../utils/icons";

const PasajeroView: React.FC = () => {
  const { userPosition, setUserPosition } = useTravel();
  const [taxiPos, setTaxiPos] = useState<{lat: number, lng: number} | null>(null);
  const [estado, setEstado] = useState<Payload['estado'] | "EnCamino" | "EnCurso" | "Finalizado" | "Buscando">("Disponible");
  const [taxistaAsignado, setTaxistaAsignado] = useState<Payload | null>(null);
  const [chatAbierto, setChatAbierto] = useState(false);
  
  // 🚩 ESTADO PARA EL RASTRO EN VIVO
  const [historialRuta, setHistorialRuta] = useState<L.LatLngExpression[]>([]);

  const taxistaAsignadoRef = useRef<Payload | null>(null);

// Actualiza la referencia cada vez que cambie el estado
useEffect(() => {
  taxistaAsignadoRef.current = taxistaAsignado;
}, [taxistaAsignado]);

  // 1. GPS Hook
  useGeolocation(
    {
      email: userPosition?.email || "",
      name: userPosition?.name || "Pasajero",
      role: "pasajero",
    },
    (pos) => {
      if (pos.lat && pos.lng) {
        setUserPosition({ ...userPosition, lat: pos.lat, lng: pos.lng } as any);
      }
    }
  );

  // 2. Escucha de Eventos Socket
  useEffect(() => {
    if (!socket) return;

    // ACEPTACIÓN DEL TAXI
socket.on("response_from_taxi", (data) => {
  console.log("🚕 Respuesta del taxi recibida:", data);
  
  if (data.accepted) {
    // 1. Limpieza inmediata de rastro y taxista previo
    setTaxistaAsignado(null);
    setTaxiPos(null);
    setHistorialRuta([]); // 🚩 Limpiamos la línea de ruta anterior

    // 2. Pequeño delay para que React limpie el mapa antes de dibujar el nuevo taxi
    setTimeout(() => {
      // Limpiamos el email entrante
      const cleanEmail = data.tEmail?.toLowerCase().trim();

      setEstado("Asignado");

      if (data.lat && data.lng) {
        setTaxiPos({ lat: data.lat, lng: data.lng });
      }

      setTaxistaAsignado({
        email: cleanEmail,
        name: data.name,
        taxiNumber: data.taxiNumber,
        role: "taxista",
        lat: data.lat || 0,
        lng: data.lng || 0,
        estado: "Asignado",
        timestamp: new Date().toISOString()
      });

      toast.success(`¡La Unidad ${data.taxiNumber} (${data.name}) va por ti!`);
    }, 100); // 100ms es el tiempo ideal para evitar parpadeos visuales
  }
});
   // MOVIMIENTO DEL TAXI antes de abordar (Usando la Ref para comparar)
    socket.on("taxi_moved", (data: any) => {
      // 🚩 Aquí usamos la Ref.current para el valor más fresco
      const emailAsignado = taxistaAsignadoRef.current?.email?.toLowerCase().trim();
      const emailEntrante = (data.tEmail || data.email || data.taxistaEmail)?.toLowerCase().trim();

      if (emailAsignado && emailEntrante === emailAsignado) {
        setTaxiPos({ lat: data.lat, lng: data.lng });
      }
    });

    // 🚩 RASTRO EN VIVO (Cuando el pasajero ya está a bordo)
    socket.on("update_trip_path", (data: { lat: number, lng: number }) => {
      setHistorialRuta((prev) => [...prev, [data.lat, data.lng]]);
      // También actualizamos la posición del taxi para que el marcador se mueva con la línea
      setTaxiPos({ lat: data.lat, lng: data.lng });
    });

    // INICIO DE VIAJE (CONFIRMAR ABORDO)
    socket.on("trip_status_update", (data: { estado: string }) => {
      if (data.estado === "EnCurso" || data.estado === "en curso") {
        setEstado("EnCurso");
        setChatAbierto(false);
        // Iniciamos el historial con la posición actual del encuentro
        if (taxiPos) setHistorialRuta([[taxiPos.lat, taxiPos.lng]]);
        toast.success("¡Viaje iniciado! Que tengas un buen trayecto.");
      }
    });

    socket.on("trip_finished", (data: { pasajeroEmail: string }) => {
      const miEmail = userPosition?.email?.toLowerCase().trim();
      const emailRecibido = data.pasajeroEmail?.toLowerCase().trim();

      if (emailRecibido === miEmail || !data.pasajeroEmail) { 
        setEstado("Finalizado"); 
        setTaxistaAsignado(null);
        setTaxiPos(null);
        setHistorialRuta([]); // Limpiar rastro
        setChatAbierto(false);
        toast.success("¡Viaje finalizado!");
      }
    });

    socket.on("taxi_rejected_request", () => {
      setTaxistaAsignado(null); 
      setTaxiPos(null);
      setEstado("Buscando"); 
      toast.info("Buscando otra unidad cercana...");
    });

    return () => {
      socket.off("taxi_moved");
      socket.off("update_trip_path");
      socket.off("response_from_taxi");
      socket.off("trip_status_update");
      socket.off("trip_finished");
      socket.off("taxi_rejected_request");
    };
  }, [socket, userPosition?.email, taxistaAsignado?.email]);

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
    if (!userPosition?.lat) {
      toast.error("📍 Esperando señal GPS...");
      return;
    }
    socket.emit("request_taxi", {
      email: userPosition.email,
      name: userPosition.name,
      lat: userPosition.lat,
      lng: userPosition.lng,
      role: "pasajero",
      estado: "Buscando",
      timestamp: new Date().toISOString(),
    });
    setEstado("Buscando");
  };

  const cancelarSolicitud = () => {
    socket.emit("passenger_cancel", {
      pasajeroEmail: userPosition?.email,
      taxistaEmail: taxistaAsignado?.email,
    });
    setEstado("Disponible");
    setTaxistaAsignado(null);
    setTaxiPos(null);
    setHistorialRuta([]);
  };

  const resetearApp = () => {
    setEstado("Disponible");
    setTaxistaAsignado(null);
    setTaxiPos(null);
    setHistorialRuta([]);
    setChatAbierto(false);
  };

return (
  <div className="h-dvh bg-slate-50 flex flex-col items-center font-sans relative overflow-hidden">
    <ToastContainer theme="light" />
    <div className="absolute top-0 left-0 w-full h-1 bg-[#22c55e] z-[2001]"></div>

    {/* HEADER: Más delgado para ganar espacio */}
    <header className="w-full max-w-md flex justify-between items-center py-3 px-6 shrink-0 bg-slate-50">
      <h1 className="text-lg font-black text-slate-800 tracking-tighter uppercase italic">
        VALLES<span className="text-[#22c55e]">VIAJE</span>
      </h1>
      <div className="flex items-center gap-2 bg-white px-3 py-1 rounded-full border border-slate-200 shadow-sm">
        <div className={`h-1.5 w-1.5 rounded-full ${userPosition?.lat ? 'bg-[#22c55e]' : 'bg-red-500 animate-pulse'}`}></div>
        <span className="text-[8px] font-black text-slate-400 uppercase">GPS</span>
      </div>
    </header>

    {/* MAIN: Ajustado para que el botón suba */}
    <main className="w-full max-w-md bg-white rounded-t-[2.5rem] shadow-2xl overflow-hidden border border-slate-100 relative flex flex-col flex-1 min-h-0">
      
      {/* 🟢 SECCIÓN DEL MAPA: Reducimos el min-h para que el panel de abajo suba */}
      <div className="flex-1 min-h-[200px] w-full relative bg-slate-100">
        {userPosition?.lat && userPosition?.lng ? (
          <MapContainer
            center={[userPosition.lat, userPosition.lng]}
            zoom={15}
            className="h-full w-full"
            zoomControl={false}
          >
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {estado !== "EnCurso" && (
              <Marker position={[userPosition.lat, userPosition.lng]} icon={pasajeroIcon} />
            )}
            {taxiPos && (estado === "Asignado" || estado === "EnCamino" || estado === "EnCurso") && (
              <Marker position={[taxiPos.lat, taxiPos.lng]} icon={taxistaIcon}>
                <Popup>Unidad {taxistaAsignado?.taxiNumber}</Popup>
              </Marker>
            )}
            {taxiPos && (estado === "Asignado" || estado === "EnCamino") && (
              <RoutingMachine 
                waypoints={[
                  L.latLng(taxiPos.lat, taxiPos.lng),
                  L.latLng(userPosition.lat, userPosition.lng)
                ]} 
              />
            )}
            {estado === "EnCurso" && historialRuta.length > 0 && (
              <Polyline 
                positions={historialRuta} 
                pathOptions={{ color: '#22c55e', weight: 6, opacity: 0.8, dashArray: '5, 10' }} 
              />
            )}
          </MapContainer>
        ) : (
          <div className="flex items-center justify-center h-full text-slate-400 font-black text-[10px] uppercase tracking-widest animate-pulse">
            Buscando tu ubicación...
          </div>
        )}

        {/* Badge de estado flotante */}
        <div className="absolute top-4 right-4 z-[1000]">
          <div className={`px-4 py-2 rounded-2xl text-[9px] font-black uppercase tracking-widest flex items-center gap-2 shadow-lg transition-all duration-500 ${
            estado === 'Disponible' 
              ? 'bg-slate-800/80 text-slate-100 backdrop-blur-md' 
              : 'bg-[#22c55e] text-white animate-pulse'
          }`}>
            {estado === 'EnCurso' ? 'VIAJE EN CURSO' : estado}
          </div>
        </div>
      </div>

      {/* ⚪ CARD DEL TAXISTA: Más compacta */}
      {taxistaAsignado && (
        <div className="mx-6 -mt-8 relative z-[1001] p-3 bg-white border border-slate-100 rounded-[1.5rem] flex items-center gap-4 shadow-xl">
          <div className="h-10 w-10 bg-green-50 rounded-xl flex items-center justify-center text-lg">🚖</div>
          <div className="flex-1">
            <p className="text-[8px] font-black text-[#22c55e] uppercase">Unidad {taxistaAsignado.taxiNumber || 'ECO'}</p>
            <p className="text-sm font-black text-slate-800 leading-tight">{taxistaAsignado.name}</p>
          </div>
        </div>
      )}

      {/* SECCIÓN DE BOTONES: Reducción de padding vertical (p-5 y pb-10) */}
      <div className="px-6 pt-5 pb-10 flex flex-col shrink-0 bg-white">
        <div className="mb-3">
          <p className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Servicio Valles</p>
          <h2 className="text-lg font-black text-slate-900 tracking-tighter leading-tight">
            {estado === 'Disponible' && "¿A dónde vamos hoy?"}
            {estado === 'Buscando' && "Buscando unidad..."}
            {(estado === 'Asignado' || estado === 'EnCamino') && "Tu taxi viene en camino"}
            {estado === 'EnCurso' && "¡Buen viaje por Valles!"}
          </h2>
        </div>

        <div className="space-y-3">
          <button
            onClick={solicitarTaxi}
            disabled={estado !== "Disponible"} 
            className={`w-full py-5 rounded-[1.2rem] font-black transition-all transform active:scale-95 shadow-xl tracking-widest text-xs ${
              estado === "Disponible"
                ? "bg-[#22c55e] text-white shadow-green-900/20" 
                : "bg-slate-800 text-slate-500 cursor-not-allowed opacity-50"
            }`}
          >
            {estado === "Disponible" ? "SOLICITAR TRANSPORTE" : "VIAJE ACTIVO"}
          </button>

          {(estado === "Buscando" || estado === "Asignado" || estado === "EnCamino") && (
            <button
              onClick={cancelarSolicitud}
              className="w-full py-3 bg-red-50 text-red-500 rounded-[1.2rem] font-bold text-[8px] uppercase border border-red-100 active:bg-red-100"
            >
              Cancelar Solicitud
            </button>
          )}
        </div>
      </div>
    </main>

    {/* CHAT AJUSTADO: Lo bajé un poquito más para que no se encime tanto con el nuevo botón más alto */}
    {taxistaAsignado?.email && (estado === 'Asignado' || estado === 'EnCamino') && (
      <div 
        className={`fixed left-0 w-full z-[2000] transition-all duration-500 flex justify-center 
        ${chatAbierto ? "bottom-0" : "bottom-[90px]"}`} 
      >
        <div className="w-[92%] max-w-md bg-white rounded-t-[2rem] rounded-b-[2rem] shadow-[0_-10px_40px_rgba(0,0,0,0.15)] border border-slate-100 overflow-hidden">
          <div onClick={() => setChatAbierto(!chatAbierto)} className="h-[55px] flex items-center justify-between px-8 cursor-pointer bg-white">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
              <span className="text-[9px] font-black text-slate-800 uppercase tracking-widest">Chat con Unidad</span>
            </div>
            <svg className={`transform transition-transform duration-500 ${chatAbierto ? "rotate-180" : "rotate-0"}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3">
              <polyline points="18 15 12 9 6 15"></polyline>
            </svg>
          </div>
          <div className={`${chatAbierto ? "h-[350px]" : "h-0"} transition-all duration-500 bg-white`}>
            <ChatBox toEmail={taxistaAsignado.email} userName={userPosition?.name || "Pasajero"} />
          </div>
        </div>
      </div>
    )}
     {/* PANTALLA DE FINALIZACIÓN: Ajustada a dvh */}
    {estado === 'Finalizado' && (
      <div className="fixed inset-0 z-[3000] bg-[#22c55e] flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in">
        <div className="bg-white rounded-[2.5rem] p-8 shadow-2xl flex flex-col items-center text-center max-w-xs w-full">
          <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center text-3xl mb-4">🚕</div>
          <h2 className="text-2xl font-black text-slate-800 tracking-tighter mb-4 uppercase leading-tight">¡Gracias por viajar con nosotros!</h2>
          <button 
            onClick={resetearApp} 
            className="w-full py-4 bg-[#22c55e] text-white rounded-2xl font-black text-xs uppercase shadow-lg active:scale-95"
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