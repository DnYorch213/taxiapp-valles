import React, { useState, useEffect } from "react";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { socket } from "../lib/socket";
import { useTravel } from "../context/TravelContext";
import { useGeolocation } from "../hooks/useGeolocation";
import { Payload } from "../types/Payload";
import { ChatBox } from "../components/ChatBox";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css"; // Asegúrate de tener el CSS de leaflet
import { RoutingMachine } from "../components/RoutingMachine"; // El que ya limpiamos
import { taxistaIcon, pasajeroIcon } from "../utils/icons";

const PasajeroView: React.FC = () => {
  const { userPosition, setUserPosition } = useTravel();
  const [taxiPos, setTaxiPos] = useState<{lat: number, lng: number} | null>(null);
  // Estados extendidos para un flujo de viaje completo
  const [estado, setEstado] = useState<Payload['estado'] | "EnCamino" | "EnCurso" | "Finalizado" | "Buscando">("Disponible");
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

   // ✅ AHORA (Mapeo robusto)
socket.on("taxista_asignado", (data: any) => {
  console.log("👤 Datos del taxista recibidos:", data);
  
  // Si el backend envía { accepted: true, taxiData: { ... } }
  // o si envía el objeto directo, esto lo captura:
  const infoLimpia = data.taxiData ? data.taxiData : data;
  
  setTaxistaAsignado(infoLimpia);
  setEstado("Asignado");
  
  // Notificación con el número de taxi
  const nTaxi = infoLimpia.taxiNumber || "S/N";
  toast.success(`Taxi ${nTaxi} asignado`);
});

// ✅ DENTRO DEL useEffect de sockets en PasajeroView.tsx
socket.on("response_from_taxi", (data) => {
  if (data.accepted) {
    setEstado("Asignado");
    
    // 🚩 CLAVE 1: Seteamos la posición inicial para que el mapa lo dibuje YA
    if (data.lat && data.lng) {
      setTaxiPos({ lat: data.lat, lng: data.lng });
    }

    // 🚩 CLAVE 2: Guardamos los datos del taxista
    setTaxistaAsignado({
      email: data.tEmail,
      name: data.name,
      taxiNumber: data.taxiNumber,
      role: "taxista",
      lat: data.lat || 0,
      lng: data.lng || 0,
      estado: "Asignado", // Usamos el mismo string que el server
      timestamp: new Date().toISOString()
    });

    toast.success(`¡Unidad ${data.taxiNumber} detectada!`);
  }
});

socket.on("taxi_moved", (data: any) => {
  // Sacamos el email del taxista asignado del ESTADO ACTUAL
  // Usamos un callback en setTaxiPos para asegurar que tenemos la info fresca si es necesario,
  // pero aquí comparamos con la variable del componente:
  
  const emailAsignado = taxistaAsignado?.email?.toLowerCase().trim();
  const emailEntrante = (data.tEmail || data.email || data.taxistaEmail)?.toLowerCase().trim();

  if (emailAsignado && emailEntrante === emailAsignado) {
    console.log("🚕 Movimiento detectado:", data.lat, data.lng);
    setTaxiPos({ lat: data.lat, lng: data.lng });
  }
});
  
    socket.on("taxi_rejected_request", () => {
    setTaxistaAsignado(null); 
    setTaxiPos(null);
    setEstado("Buscando"); 
    toast.info("Buscando otra unidad cercana...");
  });

    socket.on("trip_status_update", (data: { estado: string }) => {
      if (data.estado === "EnCurso" || data.estado === "en curso") {        setEstado("EnCurso"); 
        setTaxiPos(null); // Limpiamos la posición del taxi para que el pasajero solo vea su ubicación en el mapa
        toast.success("¡Viaje iniciado! Que tengas un buen trayecto.", { position: "top-center" });
      }
    });
socket.on("trip_finished", (data: { pasajeroEmail: string }) => {
  console.log("📩 Evento trip_finished recibido:", data);
  console.log("👤 Mi email actual:", userPosition?.email);

  // Normalizamos ambos para comparar sin errores de dedo
  const miEmail = userPosition?.email?.toLowerCase().trim();
  const emailRecibido = data.pasajeroEmail?.toLowerCase().trim();

  if (emailRecibido === miEmail || !data.pasajeroEmail) { 
    // Nota: "!data.pasajeroEmail" es un respaldo por si el servidor manda el evento a la sala privada sin el email en el body
    setEstado("Finalizado"); 
    setTaxistaAsignado(null);
    setTaxiPos(null);
    setChatAbierto(false);
    toast.success("¡Viaje finalizado! Gracias por usar VallesViaje.", { position: "top-center" });
  }
});

    return () => {
      socket.off("taxista_asignado");
      socket.off("taxi_moved");
      socket.off("response_from_taxi");
      socket.off("taxi_rejected_request");
      socket.off("trip_status_update");
      socket.off("trip_finished");
    };
  }, [socket, userPosition?.email, taxistaAsignado?.email]);

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
      estado: "Buscando",
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
    setEstado("Disponible");
    setTaxistaAsignado(null);

    toast.info("Solicitud cancelada correctamente");
  };

  const resetearApp = () => {
    setEstado("Disponible");
    setTaxistaAsignado(null);
    setTaxiPos(null);
    setChatAbierto(false);

  };

 return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center font-sans relative overflow-x-hidden">
      <ToastContainer theme="light" />
      
      {/* Franja decorativa superior */}
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
      
      {/* 📍 Marcador del Pasajero (TÚ) */}
      <Marker position={[userPosition.lat, userPosition.lng]} icon={pasajeroIcon}>
        <Popup>Estás aquí</Popup>
      </Marker>

      {/* 🚕 Marcador del Taxi (Solo si hay posición y el estado es correcto) */}
      {taxiPos && (estado === "Asignado" || estado === "EnCamino") && (
        <>
          <Marker position={[taxiPos.lat, taxiPos.lng]} icon={taxistaIcon}>
            <Popup>Tu taxi está aquí</Popup>
          </Marker>

          {/* 🛣️ Línea de ruta en tiempo real */}
          <RoutingMachine 
            waypoints={[
              L.latLng(taxiPos.lat, taxiPos.lng),    // Origen: El Taxi
              L.latLng(userPosition.lat, userPosition.lng) // Destino: Tú
            ]} 
          />
        </>
      )}
    </MapContainer>
  ) : (
    <div className="flex items-center justify-center h-full text-slate-400 font-black text-[10px] uppercase tracking-widest animate-pulse">
      Buscando tu ubicación...
    </div>
  )}


          {/* 🔵 Badge de estado flotante sobre el mapa */}
          <div className="absolute top-4 right-4 z-[1000]">
            <div className={`px-4 py-2 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 shadow-lg transition-all duration-500 ${
              estado === 'Disponible' 
                ? 'bg-slate-800/80 text-slate-100 backdrop-blur-md' 
                : 'bg-[#22c55e] text-white animate-pulse shadow-green-500/40'
            }`}>
              <div className={`h-1.5 w-1.5 rounded-full ${estado === 'Disponible' ? 'bg-slate-500' : 'bg-white'}`}></div>
              {estado === 'EnCurso' ? 'VIAJE EN CURSO' : estado}
            </div>
          </div>
        </div>

        {/* ⚪ 2. CARD DEL TAXISTA (Margen negativo para flotar sobre el mapa) */}
        {taxistaAsignado && (
          <div className="mx-6 -mt-8 relative z-[1001] p-5 bg-white border border-slate-100 rounded-[2rem] flex items-center gap-4 shadow-2xl animate-in slide-in-from-bottom-6">
            <div className="h-14 w-14 bg-green-50 rounded-[1.2rem] flex items-center justify-center text-2xl shadow-inner">🚖</div>
            <div className="flex-1">
              <p className="text-[10px] font-black text-[#22c55e] uppercase tracking-[0.2em] mb-1">Unidad {taxistaAsignado.taxiNumber || 'ECO'}</p>
              <p className="text-lg font-black text-slate-800 leading-none tracking-tight">{taxistaAsignado.name}</p>
            </div>
          </div>
        )}

        {/* 🔵 3. PANEL DE CONTROL (Contenido inferior) */}
        <div className="p-8 flex flex-col flex-1">
          <div className="mb-6">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] mb-2 text-center sm:text-left">Servicio Valles</p>
            <h2 className="text-2xl font-black text-slate-900 tracking-tighter leading-tight text-center sm:text-left">
              {estado === 'Disponible' && "¿A dónde vamos?"}
              {estado === 'Buscando' && "Buscando unidad..."}
              {estado === 'Asignado' && "¡Unidad confirmada!"}
              {estado === 'EnCamino' && "Tu taxi viene en camino"}
              {estado === 'EnCurso' && "¡Buen viaje por Valles!"}
            </h2>
          </div>

          {/* Botones de acción (Dentro del flujo del panel) */}
          <div className="space-y-4 mt-auto">
            <button
              onClick={solicitarTaxi}
              disabled={estado !== "Disponible"} 
              className={`w-full py-5 rounded-[1.8rem] font-black transition-all transform active:scale-95 shadow-2xl tracking-widest text-xs ${
                estado === "Disponible"
                  ? "bg-[#22c55e] text-white hover:bg-[#16a34a] shadow-green-900/20" 
                  : "bg-slate-800 text-slate-500 cursor-not-allowed opacity-50"
              }`}
            >
              {estado === "Disponible" ? "SOLICITAR TRANSPORTE" : "VIAJE ACTIVO"}
            </button>

            {(estado === "Buscando" || estado === "Asignado" || estado === "EnCamino") && (
              <button
                onClick={cancelarSolicitud}
                className="w-full py-4 bg-red-50 text-red-500 rounded-[1.8rem] font-bold text-[10px] uppercase tracking-tighter hover:bg-red-500 hover:text-white transition-all border border-red-100"
              >
                Cancelar Solicitud
              </button>
            )}
          </div>
        </div>
      </main>

      {/* 💬 CHAT COLAPSABLE (Fuera del main para que flote sobre todo) */}
      {taxistaAsignado && taxistaAsignado.email && (estado === 'Asignado' || estado === 'EnCamino') && (
        <div 
          className={`fixed bottom-0 left-0 w-full z-[2000] transition-all duration-500 ease-in-out flex justify-center ${
            chatAbierto ? "translate-y-0" : "translate-y-[calc(100%-70px)]"
          }`}
        >
          <div className="w-full max-w-md bg-white rounded-t-[2.5rem] shadow-[0_-20px_50px_rgba(0,0,0,0.2)] border-x border-t border-slate-100 overflow-hidden">
            <div 
              onClick={() => setChatAbierto(!chatAbierto)}
              className="h-[70px] flex items-center justify-between px-8 cursor-pointer bg-white active:bg-slate-50 border-b border-slate-50"
            >
              <div className="flex items-center gap-4">
                <div className="relative h-10 w-10 bg-green-50 rounded-2xl flex items-center justify-center text-xl shadow-sm">
                  💬
                  <div className="absolute -top-1 -right-1 h-3 w-3 bg-[#22c55e] border-2 border-white rounded-full animate-ping"></div>
                </div>
                <div>
                  <h3 className="text-[11px] font-black text-slate-800 uppercase tracking-[0.2em]">Chat con la Unidad</h3>
                  <p className="text-[9px] font-bold text-green-500 uppercase tracking-widest">
                    {chatAbierto ? "Cerrar ventana" : "Toca para escribir"}
                  </p>
                </div>
              </div>
              <div className={`p-2 rounded-full bg-slate-50 transform transition-transform duration-500 ${chatAbierto ? "rotate-180" : "rotate-0"}`}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              </div>
            </div>
            <div className="h-[450px] bg-white">
              <ChatBox toEmail={taxistaAsignado.email} userName={userPosition?.name || "Pasajero"} />
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