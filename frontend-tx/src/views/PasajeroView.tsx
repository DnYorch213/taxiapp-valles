import React, { useState, useEffect, useMemo } from "react";
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
      if (data.accepted) {
        setEstado("Asignado");
        if (data.lat && data.lng) {
          setTaxiPos({ lat: data.lat, lng: data.lng });
        }
        setTaxistaAsignado({
          email: data.tEmail,
          name: data.name,
          taxiNumber: data.taxiNumber,
          role: "taxista",
          lat: data.lat || 0,
          lng: data.lng || 0,
          estado: "Asignado",
          timestamp: new Date().toISOString()
        });
        toast.success(`¡Unidad ${data.taxiNumber} detectada!`);
      }
    });

    // MOVIMIENTO DEL TAXI (Antes de abordar)
    socket.on("taxi_moved", (data: any) => {
      const emailAsignado = taxistaAsignado?.email?.toLowerCase().trim();
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
  }, [socket, userPosition?.email, taxistaAsignado?.email, taxiPos]);

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
    <div className="min-h-screen bg-slate-50 flex flex-col items-center font-sans relative overflow-x-hidden">
      <ToastContainer theme="light" />
      <div className="absolute top-0 left-0 w-full h-2 bg-[#22c55e] z-[2001]"></div>

      <header className="w-full max-w-md flex justify-between items-center py-6 px-6">
        <h1 className="text-2xl font-black text-slate-800 tracking-tighter uppercase italic">
          VALLES<span className="text-[#22c55e]">VIAJE</span>
        </h1>
        <div className="flex items-center gap-2 bg-white px-3 py-1 rounded-full border border-slate-200 shadow-sm">
          <div className={`h-2 w-2 rounded-full ${userPosition?.lat ? 'bg-[#22c55e]' : 'bg-red-500 animate-pulse'}`}></div>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">GPS</span>
        </div>
      </header>

      <main className="w-full max-w-md bg-white rounded-t-[2.5rem] shadow-2xl overflow-hidden border border-slate-100 relative flex flex-col flex-1">
        
        {/* 🟢 SECCIÓN DEL MAPA */}
        <div className="h-80 w-full relative overflow-hidden bg-slate-100">
          {userPosition?.lat && userPosition?.lng ? (
            <MapContainer
              center={[userPosition.lat, userPosition.lng]}
              zoom={15}
              className="h-full w-full"
              zoomControl={false}
            >
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              
              {/* 📍 Marcador del Pasajero (TÚ) - SE OCULTA AL ABORDAR */}
              {estado !== "EnCurso" && (
                <Marker position={[userPosition.lat, userPosition.lng]} icon={pasajeroIcon} />
              )}

              {/* 🚕 Marcador del Taxi */}
              {taxiPos && (estado === "Asignado" || estado === "EnCamino" || estado === "EnCurso") && (
                <Marker position={[taxiPos.lat, taxiPos.lng]} icon={taxistaIcon}>
                  <Popup>Unidad {taxistaAsignado?.taxiNumber}</Popup>
                </Marker>
              )}

              {/* 🛣️ RUTA 1: Taxi yendo hacia el Pasajero */}
              {taxiPos && (estado === "Asignado" || estado === "EnCamino") && (
                <RoutingMachine 
                  waypoints={[
                    L.latLng(taxiPos.lat, taxiPos.lng),
                    L.latLng(userPosition.lat, userPosition.lng)
                  ]} 
                />
              )}

              {/* 🛣️ RUTA 2: Rastro del viaje (Polyline) cuando ya abordó */}
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

          {/* 🔵 Badge de estado flotante */}
          <div className="absolute top-4 right-4 z-[1000]">
            <div className={`px-4 py-2 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 shadow-lg transition-all duration-500 ${
              estado === 'Disponible' 
                ? 'bg-slate-800/80 text-slate-100 backdrop-blur-md' 
                : 'bg-[#22c55e] text-white animate-pulse'
            }`}>
              {estado === 'EnCurso' ? 'VIAJE EN CURSO' : estado}
            </div>
          </div>
        </div>

        {/* ⚪ CARD DEL TAXISTA */}
        {taxistaAsignado && (
          <div className="mx-6 -mt-8 relative z-[1001] p-5 bg-white border border-slate-100 rounded-[2rem] flex items-center gap-4 shadow-2xl animate-in slide-in-from-bottom-6">
            <div className="h-14 w-14 bg-green-50 rounded-1.2rem flex items-center justify-center text-2xl">🚖</div>
            <div className="flex-1">
              <p className="text-[10px] font-black text-[#22c55e] uppercase mb-1">Unidad {taxistaAsignado.taxiNumber || 'ECO'}</p>
              <p className="text-lg font-black text-slate-800 leading-none">{taxistaAsignado.name}</p>
            </div>
          </div>
        )}

        <div className="p-8 flex flex-col flex-1">
          <div className="mb-6">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] mb-2">Servicio Valles</p>
            <h2 className="text-2xl font-black text-slate-900 tracking-tighter leading-tight">
              {estado === 'Disponible' && "¿A dónde vamos?"}
              {estado === 'Buscando' && "Buscando unidad..."}
              {(estado === 'Asignado' || estado === 'EnCamino') && "Tu taxi viene en camino"}
              {estado === 'EnCurso' && "¡Buen viaje por Valles!"}
            </h2>
          </div>

          <div className="space-y-4 mt-auto">
            <button
              onClick={solicitarTaxi}
              disabled={estado !== "Disponible"} 
              className={`w-full py-5 rounded-[1.8rem] font-black transition-all transform active:scale-95 shadow-2xl tracking-widest text-xs ${
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
                className="w-full py-4 bg-red-50 text-red-500 rounded-[1.8rem] font-bold text-[10px] uppercase border border-red-100"
              >
                Cancelar Solicitud
              </button>
            )}
          </div>
        </div>
      </main>

      {/* 💬 CHAT (Se oculta al abordar) */}
      {taxistaAsignado?.email && (estado === 'Asignado' || estado === 'EnCamino') && (
        <div className={`fixed bottom-0 left-0 w-full z-[2000] transition-all duration-500 flex justify-center ${chatAbierto ? "translate-y-0" : "translate-y-[calc(100%-70px)]"}`}>
          <div className="w-full max-w-md bg-white rounded-t-[2.5rem] shadow-2xl border-x border-t border-slate-100 overflow-hidden">
            <div onClick={() => setChatAbierto(!chatAbierto)} className="h-[70px] flex items-center justify-between px-8 cursor-pointer bg-white active:bg-slate-50 border-b border-slate-50">
              <span className="text-[11px] font-black text-slate-800 uppercase tracking-widest">Chat con la Unidad</span>
              <div className={`transform transition-transform duration-500 ${chatAbierto ? "rotate-180" : "rotate-0"}`}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3"><polyline points="18 15 12 9 6 15"></polyline></svg>
              </div>
            </div>
            <div className="h-[450px] bg-white">
              <ChatBox toEmail={taxistaAsignado.email} userName={userPosition?.name || "Pasajero"} />
            </div>
          </div>
        </div>
      )}  

      {/* 🌟 PANTALLA DE FINALIZACIÓN */}
      {estado === 'Finalizado' && (
        <div className="fixed inset-0 z-[2000] bg-[#22c55e] flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in duration-500">
          <div className="bg-white rounded-[3rem] p-10 shadow-2xl flex flex-col items-center text-center max-w-sm w-full">
            <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center text-4xl mb-6">🚕</div>
            <h2 className="text-3xl font-black text-slate-800 tracking-tighter mb-4 uppercase">¡Gracias por tu preferencia!</h2>
            <button 
              onClick={resetearApp} 
              className="w-full py-5 bg-[#22c55e] text-white rounded-2xl font-black text-sm uppercase shadow-xl"
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