import React, { useState, useEffect, useMemo, useRef } from "react";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { socket } from "../lib/socket";
import { useTravel } from "../context/TravelContext";
import { useGeolocation } from "../hooks/useGeolocation";
import { Payload, ViajeEstado } from "../types/Payload";
import { ChatBox } from "../components/ChatBox";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { RoutingMachine } from "../components/RoutingMachine";
import { taxistaIcon, pasajeroIcon } from "../utils/icons";
import RotatedMarker from "../components/RotatedMarker";
import { calcularHeading } from "../utils/heading";

const PasajeroView: React.FC = () => {
  const { userPosition, setUserPosition, taxiPos, setTaxiPos } = useTravel();
  const [estado, setEstado] = useState<ViajeEstado>("pendiente");
  const [taxistaAsignado, setTaxistaAsignado] = useState<Payload | null>(null);
  const [chatAbierto, setChatAbierto] = useState(false);
  const [historialRuta, setHistorialRuta] = useState<L.LatLngExpression[]>([]);
  const [geometriaRuta, setGeometriaRuta] = useState<L.LatLng[]>([]);

  const taxistaAsignadoRef = useRef<Payload | null>(null);
  // 🎯 NUEVAS REFS PARA EVITAR RESETEAR EL EFFECT
  const estadoRef = useRef<ViajeEstado>("pendiente");
  const taxiPosRef = useRef<any>(null);

  useEffect(() => {
    taxistaAsignadoRef.current = taxistaAsignado;
  }, [taxistaAsignado]);

  // Sincronizamos las nuevas referencias
  useEffect(() => {
    estadoRef.current = estado;
  }, [estado]);

  useEffect(() => {
    taxiPosRef.current = taxiPos;
  }, [taxiPos]);

 // 🎯 1. Tu useMemo limpio y corregido (mantén la Opción A o B que elegiste)
const geoConfig = useMemo(() => ({
  email: userPosition?.email || "",
  name: userPosition?.name || "Pasajero",
  role: "pasajero" as const, 
}), [userPosition?.email]);

// 🎯 2. Invocamos useGeolocation pasando el objeto directo exigido por el Contexto
useGeolocation(
  geoConfig,
  (pos) => {
    if (pos.lat && pos.lng) {
      // 🛡️ CORRECCIÓN: Validamos el cambio antes de enviarlo, pero pasamos el objeto directo
      if (userPosition?.lat !== pos.lat || userPosition?.lng !== pos.lng) {
        setUserPosition({
          ...userPosition,
          lat: pos.lat,
          lng: pos.lng
        } as any);
      }
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
        setTaxiPos(null);
        setHistorialRuta([]); 

        const cleanEmail = data.tEmail?.toLowerCase().trim();
        
        setTimeout(() => {
          setEstado("asignado");

          const infoTaxista = {
            email: cleanEmail,
            name: data.name || "Taxista",
            taxiNumber: data.taxiNumber || "S/N",
            role: "taxista",
            lat: data.lat || 0,
            lng: data.lng || 0,
            estado: "asignado",
            timestamp: new Date().toISOString()
          };

          setTaxistaAsignado(infoTaxista as Payload);

          if (data.lat && data.lng) {
            setTaxiPos({ lat: data.lat, lng: data.lng, heading: 0 });
          }

          toast.success(`¡La Unidad ${data.taxiNumber} (${data.name}) va en camino!`, {
            position: "top-center",
            autoClose: 5000
          });
        }, 100);
      }
    });

    socket.on("taxi_moved", (data: any) => {
      const emailAsignado = taxistaAsignadoRef.current?.email?.toLowerCase().trim();
      const emailEntrante = (data.tEmail || data.email || data.taxistaEmail)?.toLowerCase().trim();

      if (emailAsignado && emailEntrante === emailAsignado) {
        setTaxiPos((prev) => {
          const heading = calcularHeading(
            prev ? { lat: prev.lat, lng: prev.lng } : null,
            { lat: data.lat, lng: data.lng },
            userPosition ? { lat: userPosition.lat!, lng: userPosition.lng! } : null,
           estadoRef.current // 🎯 Usamos la ref para leer el estado fresco sin reiniciar el effect
          );
          return { lat: data.lat, lng: data.lng, heading };
        });
      }
    });

    socket.on("update_trip_path", (data: { lat: number, lng: number }) => {
      setHistorialRuta((prev) => [...prev, [data.lat, data.lng]]);
      setTaxiPos({ lat: data.lat, lng: data.lng, heading: 0 });
    });

    // INICIO Y FIN DE VIAJE (CONFIRMAR ABORDO DESDE SERVER)
    socket.on("trip_status_update", (data: { estado: string }) => {
      if (data.estado === "encurso") {
        setEstado("encurso");
        setChatAbierto(false);
        // 🎯 Usamos taxiPosRef para evitar la dependencia directa
        if (taxiPosRef.current) setHistorialRuta([[taxiPosRef.current.lat, taxiPosRef.current.lng]]);
        toast.success("¡Viaje iniciado! Que tengas un buen trayecto.");
      }

       // 🛡️ Escudo extra: si ya estamos en encurso, finalizado o pendiente, ignoramos cualquier 'buscando'
 if (["encurso", "finalizado", "pendiente"].includes(estadoRef.current) && data.estado === "buscando") {
    console.warn("🛡️ [Frontend Escudo] Ignorado salto a 'buscando' porque el viaje ya está cerrado o en curso.");
    return;
  }
      
      // 🛡️ CORRECCIÓN: Al finalizar regresamos a 'pendiente', NO a 'buscando'
      if (data.estado === "finalizado") {
        setEstado("pendiente"); 
        setHistorialRuta([]);
        setTaxistaAsignado(null);
        setTaxiPos(null);
        setChatAbierto(false);
        toast.success("¡Viaje finalizado!");
      }
    });

    // ESCUCHA DE CANCELACIÓN O FIN EXPLICITO
    socket.on("trip_finished", (data: { pasajeroEmail: string }) => {
      const miEmail = userPosition?.email?.toLowerCase().trim();
      const emailRecibido = data.pasajeroEmail?.toLowerCase().trim();

      if (emailRecibido === miEmail || !data.pasajeroEmail) { 
        setEstado("pendiente"); // 🛡️ CORRECCIÓN: Volvemos al inicio seguro
        setTaxistaAsignado(null);
        setTaxiPos(null);
        setHistorialRuta([]); 
        setChatAbierto(false);

        // 🚀 ¡AQUÍ VA EL TOAST FALTANTE! 
    toast.success("¡Viaje finalizado! Gracias por viajar con nosotros.", {
      position: "top-center",
      autoClose: 4000
    });
      }
    });

    socket.on("taxi_rejected_request", () => {
      setTaxistaAsignado(null); 
      setTaxiPos(null);
      setEstado("buscando"); 
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
  }, [socket, userPosition?.email]);

  // 3. Heartbeat Controlado (Optimizado para no interrumpir despachos)
  useEffect(() => {
    if (!userPosition?.email || !userPosition?.lat) return;
    
    const interval = setInterval(() => {
      // 🛡️ CANDADO: Si el estado es pendiente o cancelado, el heartbeat no envía basura de posicionamiento activo
      if (estado === "pendiente" || estado === "finalizado") return;

      socket.emit("position", {
        ...userPosition,
        role: "pasajero",
        estado: estado.toLowerCase()
      });
    }, 12000); // Subimos ligeramente a 12s para desahogar cuellos de botella en Mongo
    
    return () => clearInterval(interval);
  }, [userPosition, estado]);

 const solicitarTaxi = () => {

  // 🎯 ESCUDO ANTIDISPAROS ASÍNCRONOS:
  // Si el pasajero ya tiene un viaje activo o el taxista va hacia él / ya van en camino,
  // bloqueamos por completo cualquier emisión accidental hacia el socket.
  if (["asignado", "encamino", "encurso"].includes(estado)) {
    console.warn("🛡️ [Frontend Escudo] Intento de solicitarTaxi bloqueado: El viaje ya está activo o en curso.");
    return;
  }

  if (!userPosition?.lat || !userPosition?.lng) {
    toast.error("📍 Esperando señal GPS...");
    return;
  }

   
  setEstado("buscando");
  
  socket.emit("request_taxi", {
    email: userPosition.email.toLowerCase().trim(),
    name: userPosition.name,
    lat: userPosition.lat,
    lng: userPosition.lng,
    role: "pasajero",
    estado: "buscando",
    timestamp: new Date().toISOString(),
  });
};

  const cancelarSolicitud = () => {
    setEstado("pendiente"); // Primero apagamos el estado local para congelar el Heartbeat
    
    socket.emit("passenger_cancel", {
      pasajeroEmail: userPosition?.email?.toLowerCase().trim(),
      taxistaEmail: taxistaAsignado?.email?.toLowerCase().trim() || null,
    });
    
    setTaxistaAsignado(null);
    setTaxiPos(null);
    setHistorialRuta([]);
    toast.info("Solicitud cancelada correctamente.");
  };

  const resetearApp = () => {
    setEstado("pendiente");
    setTaxistaAsignado(null);
    setTaxiPos(null);
    setHistorialRuta([]);
    setChatAbierto(false);
  };

  // 🎯 Agrega esto arriba de tu return principal en PasajeroView.tsx
const obtenerTextoEstado = () => {
  if (estado === 'pendiente') return 'ACTIVO';
  if (estado === 'encurso') return 'VIAJE EN CURSO';
  return estado ? estado.toUpperCase() : '';
};

  return (
    <div className="h-dvh bg-slate-50 flex flex-col items-center font-sans relative overflow-hidden">
      <ToastContainer theme="light" />
      <div className="absolute top-0 left-0 w-full h-1 bg-[#22c55e] z-[2001]"></div>

      {/* HEADER */}
      <header className="w-full max-w-md flex justify-between items-center py-3 px-6 shrink-0 bg-slate-50">
        <h1 className="text-lg font-black text-slate-800 tracking-tighter uppercase italic">
          VALLES<span className="text-[#22c55e]">VIAJE</span>
        </h1>
        <div className="flex items-center gap-2 bg-white px-3 py-1 rounded-full border border-slate-200 shadow-sm">
          <div className={`h-1.5 w-1.5 rounded-full ${userPosition?.lat ? 'bg-[#22c55e]' : 'bg-red-500 animate-pulse'}`}></div>
          <span className="text-[8px] font-black text-slate-400 uppercase">GPS</span>
        </div>
      </header>

      {/* MAIN */}
      <main className="w-full max-w-md bg-white rounded-t-[2.5rem] shadow-2xl overflow-hidden border border-slate-100 relative flex flex-col flex-1 min-h-0">
        
        {/* MAPA */}
        <div className="flex-1 min-h-[200px] w-full relative bg-slate-100">
          {userPosition?.lat && userPosition?.lng ? (
            <MapContainer
              center={[userPosition.lat, userPosition.lng]}
              zoom={15}
              className="h-full w-full"
              zoomControl={false}
            >
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

              {estado !== "encurso" && (
                <Marker position={[userPosition.lat, userPosition.lng]} icon={pasajeroIcon} />
              )}

              {taxiPos && (estado === "asignado" || estado === "encamino" || estado === "encurso") && (
                <RotatedMarker 
                  position={[taxiPos.lat, taxiPos.lng]} 
                  icon={taxistaIcon} 
                  rotationAngle={taxiPos.heading || 0}
                >
                  <Popup>Unidad {taxistaAsignado?.taxiNumber}</Popup>
                </RotatedMarker>
              )}

           {/* ==================== SECCIÓN DE LÍNEAS DEL MAPA (SIN PARPADEO) ==================== */}

{/* 🟪 LINEA 1: Se dibuja fluidamente porque geometríaRuta ya no se borra ni se sobreescribe en bucle */}
{(estado === "asignado" || estado === "encamino") && geometriaRuta.length > 0 && (
  <Polyline
    positions={geometriaRuta}
    pathOptions={{
      color: '#d02692',
      weight: 6,
      opacity: 0.9,
      dashArray: '10, 15',
      lineJoin: 'round',
      lineCap: 'round'
    }}
  />
)}

{/* 🗺️ CONTROL DE ENRUTAMIENTO (🎯 CANDADO DE DISPARO ÚNICO) */}
{/* Al añadir "geometriaRuta.length === 0", el componente calcula la ruta UNA sola vez. */}
{/* En cuanto encuentra las coordenadas, se desmonta y deja la línea fija y hermosa en el mapa */}
{taxiPos?.lat && taxiPos?.lng && userPosition?.lat && userPosition?.lng && 
 (estado === "asignado" || estado === "encamino") && geometriaRuta.length === 0 && (
  <RoutingMachine 
    waypoints={[
      L.latLng(Number(taxiPos.lat), Number(taxiPos.lng)),
      L.latLng(Number(userPosition.lat), Number(userPosition.lng))
    ]} 
    onRouteFound={(coords: L.LatLng[]) => setGeometriaRuta(coords)}
  />
)}

{/* 🟩 LINEA 2: El rastro del viaje en curso */}
{estado === "encurso" && historialRuta.length > 0 && (
  <Polyline 
    positions={historialRuta} 
    pathOptions={{ 
      color: '#22c55e', 
      weight: 6, 
      opacity: 0.8,
      lineJoin: 'round'
    }} 
  />
)}
            </MapContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-400 font-black text-[10px] uppercase tracking-widest animate-pulse">
              Buscando tu ubicación...
            </div>
          )}
        </div>

          {/* Badge de estado flotante */}
<div className="absolute top-4 right-4 z-[1000]">
  <div className={`px-4 py-2 rounded-2xl text-[9px] font-black uppercase tracking-widest flex items-center gap-2 shadow-lg transition-all duration-500 ${
    estado === 'encurso' 
      ? 'bg-slate-800/80 text-slate-100 backdrop-blur-md' 
      : 'bg-[#22c55e] text-white animate-pulse'
  }`}>
    {/* 🚀 Llamada limpia y segura que no rompe a Vite */}
    {obtenerTextoEstado()}
  </div>
</div>

        {/* CARD DEL TAXISTA */}
        {taxistaAsignado && (
          <div className="mx-6 -mt-8 relative z-[1001] p-3 bg-white border border-slate-100 rounded-[1.5rem] flex items-center gap-4 shadow-xl">
            <div className="h-10 w-10 bg-green-50 rounded-xl flex items-center justify-center text-lg">🚖</div>
            <div className="flex-1 flex items-baseline gap-2"> 
              <p className="text-[14px] font-black text-slate-800 leading-tight">
                {taxistaAsignado.name}
              </p>
              <p className="text-[16px] font-black text-[#22c55e] whitespace-nowrap">
                Taxi {taxistaAsignado.taxiNumber || 'ECO'}
              </p>
            </div>
          </div>
        )}

       {/* SECCIÓN DE BOTONES MODIFICADA */}
<div className="px-6 pt-5 pb-18 flex flex-col shrink-0 bg-white">
  <div className="mb-3">
    <p className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Servicio Valles</p>
    <h2 className="text-lg font-black text-slate-900 tracking-tighter leading-tight">
      {estado === 'pendiente' && "¿A dónde vamos hoy?"}
      {estado === 'buscando' && "Buscando unidad..."}
      {(estado === 'asignado' || estado === 'encamino') && "Tu taxi viene en camino"}
      {estado === 'encurso' && "¡Buen viaje por Valles!"}
    </h2>
  </div>

  <div className="space-y-3">
    <button
      onClick={solicitarTaxi}
      // 🎯 CANDADO ULTRA-ESTRICTO: Solo se puede clickear si el estado es exactamente "pendiente"
      disabled={estado !== "pendiente"} 
      className={`w-full py-5 rounded-[1.2rem] font-black transition-all transform active:scale-95 shadow-xl tracking-widest text-xs ${
        estado === "pendiente"
          ? "bg-[#22c55e] text-white shadow-green-900/20" 
          : "bg-slate-800 text-slate-500 cursor-not-allowed opacity-50"
      }`}
    >
      {estado === "pendiente" ? "SOLICITAR TRANSPORTE" : "VIAJE ACTIVO"}
    </button>

    {/* 🎯 INCLUIMOS "preasignado" para que el botón de cancelar no desaparezca en las transiciones de estados del servidor */}
    {(estado === "buscando" || estado === "preasignado" || estado === "asignado" || estado === "encamino") && (
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

      {/* CHAT */}
      {taxistaAsignado?.email && (estado === 'asignado' || estado === 'encamino') && (
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
              <ChatBox toEmail={taxistaAsignado.email || taxistaAsignado.taxistaEmail || ""} userName={userPosition?.name || "Pasajero"} />
            </div>
          </div>
        </div>
      )}

      {/* PANTALLA DE FINALIZACIÓN */}
      {estado === 'finalizado' && (
        <div className="fixed inset-0 z-[3000] bg-[#22c55e] flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in">
          <div className="bg-white rounded-[2.5rem] p-8 shadow-2xl flex flex-col items-center text-center max-w-xs w-full">
            <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center text-3xl mb-4">🚕</div>
            <div className="text-2xl font-black text-slate-800 tracking-tighter mb-4 uppercase leading-tight">¡Gracias por viajar con nosotros!</div>
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