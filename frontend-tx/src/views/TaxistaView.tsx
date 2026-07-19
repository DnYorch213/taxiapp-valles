import React, { Suspense, lazy, useState, useEffect, useMemo, useRef, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet"; // 🚩 Importamos Polyline
import { toast, ToastContainer } from "react-toastify";
import L from 'leaflet';
import axiosInstance from "../lib/axiosConfig";
import "react-toastify/dist/ReactToastify.css";
import "leaflet/dist/leaflet.css";
import RotatedMarker from "../components/RotatedMarker";
import { socket } from "../lib/socket";
import { useTravel } from "../context/TravelContext";
import { useGeolocation } from "../hooks/useGeolocation";
import { Payload } from "../types/Payload";
import { ChatBox } from "../components/ChatBox";
import { HistorialViajes } from "../components/HistorialViajes";
import { taxistaIcon, pasajeroIcon } from "../utils/icons";
import { calcularHeading } from "../utils/heading"; // Función para calcular el heading entre dos puntos
import { POSITION_STATES, STATE_GROUPS, PositionState } from "../constants/states";

const RoutingMachine = lazy(() =>
  import("../components/RoutingMachine").then((module) => ({
    default: module.RoutingMachine,
  }))
);

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

const VAPID_PUBLIC_KEY = "BHtVjCOYiH1nbyPq-mPS_ZqA0oHjGcONq5r5PV-sTC1jXzAvgGuFFwL5iv0ymk725NUX4_obl82JLilVs9W49-A";
const ROUTE_RECALC_THRESHOLD_METERS = 120;
const OFFROAD_TAIL_THRESHOLD_METERS = 22;

const finishFlagIcon = L.divIcon({
  className: "",
  html: `
    <div style="position:relative;width:28px;height:40px;filter:drop-shadow(0 6px 10px rgba(0,0,0,0.35));">
      <div style="position:absolute;left:12px;top:6px;width:3px;height:28px;background:#ffffff;border-radius:2px;"></div>
      <div style="position:absolute;left:14px;top:6px;width:12px;height:10px;clip-path:polygon(0 0,100% 0,74% 52%,100% 100%,0 100%);background:conic-gradient(from 90deg,#ffffff 0 25%,#111827 0 50%,#ffffff 0 75%,#111827 0);"></div>
      <div style="position:absolute;left:8px;bottom:2px;width:12px;height:6px;background:#0f172a;border:1px solid rgba(255,255,255,0.65);border-radius:9999px;"></div>
    </div>
  `,
  iconSize: [28, 40],
  iconAnchor: [14, 38],
});

const sanitizeRouteTail = (coords: L.LatLng[]) => {
  if (!coords || coords.length < 3) return coords;

  const last = coords[coords.length - 1];
  const prev = coords[coords.length - 2];
  const tailDistance = prev.distanceTo(last);

  // Si el último tramo es un salto corto fuera de calle, lo recortamos para evitar parpadeo visual.
  if (tailDistance >= OFFROAD_TAIL_THRESHOLD_METERS) {
    return coords.slice(0, -1);
  }

  return coords;
};

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

const MapFixer = () => {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
  }, [map]);
  return null;
};

const TaxistaView: React.FC = () => {
  const CHAT_BUBBLE_SIZE = 52;
  const CHAT_BUBBLE_MARGIN = 12;
  const CHAT_PANEL_HEIGHT = 260;

  const { userPosition, taxiPos, setTaxiPos } = useTravel();
  const [estado, setEstado] = useState<PositionState>(POSITION_STATES.ACTIVO);
  const [viajeSolicitado, setViajeSolicitado] = useState<Payload | null>(null);
  const [pasajeroAsignado, setPasajeroAsignado] = useState<Payload | null>(null);
  const [excludedEmails, setExcludedEmails] = useState<string[]>([]);
  const [chatAbierto, setChatAbierto] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [chatBubbleX, setChatBubbleX] = useState<number | null>(null);
  const [chatBubbleY, setChatBubbleY] = useState<number | null>(null);
  const [isDraggingChatBubble, setIsDraggingChatBubble] = useState(false);

  // 🚩 ESTADO PARA EL RASTRO DEL VIAJE
  const [historialRuta, setHistorialRuta] = useState<L.LatLngExpression[]>([]);
  // 🚩 ESTADO PARA LA LÍNEA QUE SE VA BORRANDO (Hacia el pasajero)
const [geometriaRuta, setGeometriaRuta] = useState<L.LatLng[]>([]);
  const [rutaDestinoFinal, setRutaDestinoFinal] = useState<L.LatLng[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const chatDragRef = useRef({
    startPointerX: 0,
    startPointerY: 0,
    startBubbleX: 0,
    startBubbleY: 0,
    moved: false,
  });
  const estadoRef = useRef(estado);
  const pasajeroAsignadoRef = useRef<Payload | null>(null);
  const taxiPosRef = useRef(taxiPos);
  const pushRehydrateRef = useRef<{ pasajero: string | null; taxista: string | null; autoAccept: boolean }>({
    pasajero: null,
    taxista: null,
    autoAccept: false,
  });
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [vistaActual, setVistaActual] = useState('mapa'); // 'mapa' o 'historial'
  const [isAccepting, setIsAccepting] = useState(false);

  useEffect(() => {
  if (estado === "finalizado" || estado === "activo" || estado === "encamino") {
    setTimeout(() => setGeometriaRuta([]), 300);
  }
}, [estado]);

  useEffect(() => {
    if (estado !== "encurso") {
      setRutaDestinoFinal([]);
    }
  }, [estado]);

// Sincronizador de referencia mutuable para hooks de hardware
useEffect(() => {
  estadoRef.current = estado;
}, [estado]);

useEffect(() => {
  pasajeroAsignadoRef.current = pasajeroAsignado;
}, [pasajeroAsignado]);

useEffect(() => {
  taxiPosRef.current = taxiPos;
}, [taxiPos]);

const getDestinoFinalLatLng = useCallback((payload?: Partial<Payload> | null) => {
  if (!payload) return null;

  const rawLat = payload.destinationLat;
  const rawLng = payload.destinationLng;
  if (rawLat === null || rawLat === undefined || rawLng === null || rawLng === undefined) {
    return null;
  }

  const lat = Number(rawLat);
  const lng = Number(rawLng);

  // Evitar destinos inválidos (p.ej. null convertido a 0) que generan líneas fantasma.
  const coordsInvalidas = !Number.isFinite(lat) || !Number.isFinite(lng) ||
    Math.abs(lat) > 90 || Math.abs(lng) > 180 ||
    (lat === 0 && lng === 0);

  if (!coordsInvalidas) {
    return L.latLng(lat, lng);
  }

  return null;
}, []);



 // 🚩 REHIDRATACIÓN DESDE QUERY PARAMS O ACCIONES PUSH
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const pasajero = params.get("pasajero");
  const taxista = params.get("taxista");
  const autoAccept = params.get("autoAccept");
  const isPushFlow = Boolean(pasajero && taxista);

  pushRehydrateRef.current = {
    pasajero,
    taxista,
    autoAccept: autoAccept === "true",
  };

  if (isPushFlow) {
    console.log("🔄 Rehidratando viaje desde notificación:", pasajero, taxista);
    
    // Si viene del botón aceptar del Push, forzamos un estado de carga inmediato
    if (autoAccept === "true") {
      setIsAccepting(true);
      setEstado(POSITION_STATES.ENCAMINO); // Lo movemos visualmente a ruta mientras responde el socket
    }

    // Si ya hay conexión, disparamos de inmediato. Si no, se reintentará en el listener de connect.
    if (socket.connected) {
      socket.emit("request_rehydrate");
    }
  }
}, []);


  // --- 🔔 FUNCIÓN DE SUSCRIPCIÓN BLINDADA Y RE-SUSCRIPCIÓN AUTOMÁTICA ---
const gestionarSuscripcion = async () => {
  // Intentamos obtener el email de donde sea que esté disponible
  const userEmail = userPosition?.email || localStorage.getItem("email");

  if (!userEmail) {
    console.log("ℹ️ Esperando email del taxista para verificar suscripción Push...");
    return;
  }

  // 1. Validaciones del entorno del navegador
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn("❌ Este dispositivo o navegador no soporta Notificaciones Push.");
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    
    // 2. Revisamos si ya existe una suscripción en el Service Worker
    let subscription = await registration.pushManager.getSubscription();
    
    // Si la suscripción no existe (debido a limpieza de cookies/datos), forzamos una nueva
    if (!subscription) {
      console.log("⚠️ No se encontró suscripción activa (posible borrado de datos). Re-suscribiendo...");
      
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }

    // 3. Sincronización proactiva con el Backend
    if (subscription) {
      console.log(`🔄 Sincronizando token push en servidor para: ${userEmail}`);
      
      await axiosInstance.post(`/api/save-subscription`, {
        email: userEmail.toLowerCase().trim(),
        subscription: subscription
      });
      
      console.log("✅ Suscripción Push validada y sincronizada correctamente.");
    }
  } catch (err: any) {
    // Si el usuario denegó los permisos explícitamente en el navegador
    if (Notification.permission === 'denied') {
      console.warn("🚫 El taxista bloqueó los permisos de notificación en su navegador.");
    } else {
      console.error("❌ Error crítico en el ciclo de re-suscripción:", err);
    }
  }
};

// --- EFFECT CORREGIDO ---
// Escuchamos de forma segura tanto el estado del GPS como el inicio de sesión manual
useEffect(() => {
  const miEmail = userPosition?.email || localStorage.getItem("email");
  if (miEmail) {
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

// --- 🛰️ GEOLOCALIZACIÓN OPTIMIZADA Y BLINDADA CON HEADING REAL (TAXISTA) ---
useGeolocation(
  {
    email: userPosition?.email || localStorage.getItem("email") || "",
    name: localStorage.getItem("userName") || userPosition?.name || "Taxista",
    role: "taxista",
    taxiNumber: userPosition?.taxiNumber || localStorage.getItem("taxiNumber") || "",
    estado: estado, 
  },
  (pos) => {
    if (pos.lat === null || pos.lng === null) return;

    // 🎯 Capturamos el estado real y fresco directamente desde la referencia mutable
    const estadoActual = estadoRef.current;

    // 1. Guardamos de inmediato en el estado local calculando el ángulo de rumbo real
    setTaxiPos((prev) => {
      const heading = calcularHeading(
        prev ? { lat: prev.lat, lng: prev.lng } : null,
        { lat: Number(pos.lat), lng: Number(pos.lng) }, 
        pasajeroAsignado ? { lat: Number(pasajeroAsignado.lat), lng: Number(pasajeroAsignado.lng) } : null,
        estadoActual, // 🎯 CORRECCIÓN CRÍTICA: Cambiado 'estado' por 'estadoActual' (evita el closure)
        prev?.heading || 0
      );
      
      return {
        lat: Number(pos.lat), 
        lng: Number(pos.lng), 
        heading: heading || 0, // Si da nulo, mantiene la última dirección frontal
        taxiNumber: localStorage.getItem("taxiNumber") || userPosition?.taxiNumber || "S/N"
      };
    });  

    // 🎯 EXTRACCIÓN SINCRA ANTI-CLOSURE DEL HARDWARE:
    const miEmailLimpio = localStorage.getItem("email") || userPosition?.email;
    const miTaxiEco = localStorage.getItem("taxiNumber") || userPosition?.taxiNumber || "S/N";
    
    if (!miEmailLimpio) return; 

    // 2. Envío de telemetría limpia en tiempo real (Dentro de useGeolocation en TaxistaView.tsx)
    if (["asignado", "encamino", "encurso"].includes(estadoActual)) {
      const latNum = Number(pos.lat);
      const lngNum = Number(pos.lng);

      // 🎯 RESPALDO EN BASE DE DATOS MEDIANTE TU NUEVO ENDPOINT DE AUTH:
      // Si el WebSocket parpadea, Axios se encarga de guardar el avance real directamente en Atlas
      axiosInstance.post(`/api/auth/positions/update-gps`, {
        email: miEmailLimpio.toLowerCase().trim(),
        lat: latNum,
        lng: lngNum,
        estado: estadoActual
      }).catch(err => console.warn("🛰️ [GPS Backup] Esperando red para actualizar Atlas..."));

      // 3. Envío al canal virtual del Socket si hay señal de datos activa
      if (socket && socket.connected) {
        if (estadoActual === "encurso") {
          const nuevaCoord: L.LatLngExpression = [latNum, lngNum];
          setHistorialRuta((prev) => [...prev, nuevaCoord]);
          
          socket.emit("update_trip_path", {
            pasajeroEmail: pasajeroAsignado?.email || pasajeroAsignado?.pasajeroEmail,
            lat: latNum, 
            lng: lngNum, 
          });
        } else {
          socket.emit("taxi_moved", {
            lat: latNum, 
            lng: lngNum, 
            email: miEmailLimpio.toLowerCase().trim(),
            taxiNumber: miTaxiEco,
            role: "taxista"
          });
        }
      }
    }
  },
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

  // 🚩 REHIDRATACIÓN AUTOMÁTICA AL CARGAR
useEffect(() => {
  const onConnectRehydrate = () => {
    const { pasajero, taxista } = pushRehydrateRef.current;
    if (pasajero && taxista) {
      console.log("🔄 Rehidratación de respaldo tras reconexión de socket");
      socket.emit("request_rehydrate");
    }
  };

  // Intentar rehidratar de inmediato
  checkStatus();
  onConnectRehydrate();

  // Si el socket tarda en conectar, reintentar al conectar
  socket.on("connect", checkStatus);
  socket.on("connect", onConnectRehydrate);
  
  return () => {
    socket.off("connect", checkStatus);
    socket.off("connect", onConnectRehydrate);
  };
}, [checkStatus]);

const handleAsignacion = useCallback((data: any) => {
  console.log("📩 Nueva asignación recibida:", data);

  // 1. EXTRACCIÓN Y LIMPIEZA: Manejamos si viene de Mongoose (_doc) o es objeto plano
  const rawData = data._doc ? data._doc : data;
  
  // Validamos que el email exista para evitar el error de "undefined" al aceptar
  if (!rawData.email) {
    console.error("❌ Error crítico: Los datos recibidos no tienen email", data);
    return;
  }

  const incomingEmail = String(rawData.email).toLowerCase().trim();
  const estadoActual = estadoRef.current;
  const actualAsignado = pasajeroAsignadoRef.current?.email?.toLowerCase().trim();

  // Ignorar ofertas tardías cuando el viaje ya está confirmado o en curso.
  if (["encamino", "encurso"].includes(estadoActual)) {
    if (!actualAsignado || actualAsignado === incomingEmail) {
      console.warn("🛡️ Oferta tardía ignorada: el viaje ya está en estado activo.");
      return;
    }
  }

  // Durante confirmación de aceptación por push, ignorar nuevas ofertas para evitar rebote a 'asignado'.
  if (isAccepting && data.isNewOffer) {
    console.warn("🛡️ Oferta ignorada durante confirmación push.");
    return;
  }

  setTimeout(() => {
    // 2. ACTUALIZACIÓN DE ESTADOS
    // Limpiamos el email por si trae la "k" extra o espacios
    const pEmail = incomingEmail;
setPasajeroAsignado({ 
  ...rawData, 
  email: pEmail, 
  attempt: data.attempt,
  pasajeroEmail: rawData.pasajeroEmail || pEmail,
  pasajeroLat: rawData.pasajeroLat || rawData.lat,
  pasajeroLng: rawData.pasajeroLng || rawData.lng,
  distancia: rawData.distancia || null
 });
    setExcludedEmails(data.excludedEmails || []);
    
    const estadoServidor = rawData.estado?.toLowerCase().trim();

    // 3. LÓGICA DE FLUJO (Diferenciando Oferta Nueva vs Viaje Activo)
    
    if (data.isNewOffer) {
      /**
       * CASO A: Oferta Nueva (Viene del salto de Jorge o solicitud inicial)
       * Forzamos estado "Asignado" para que React muestre el botón de ACEPTAR.
       */
      setEstado(POSITION_STATES.ASIGNADO); 
      reproducirAlerta();
    } 
   else if (estadoServidor === "encurso") {
  // CASO B: Viaje ya iniciado
  setEstado(POSITION_STATES.ENCURSO);
  detenerSonido();
} 
else if (estadoServidor === "encamino") {
  // CASO C: Taxista en camino al pasajero
  setEstado(POSITION_STATES.ENCAMINO);
  detenerSonido();
} 
else if (estadoServidor === "asignado") {
  // CASO D: Reconexión (ya aceptó pero aún no se mueve)
  setEstado(POSITION_STATES.ASIGNADO);
  detenerSonido();
} 
else {
  // Backup de seguridad
  setEstado(POSITION_STATES.ASIGNADO); 
  reproducirAlerta();
}

  }, 10);
}, [detenerSonido, reproducirAlerta, isAccepting]);

  useEffect(() => {
    if (!socket) return;

    socket.on("pasajero_asignado", handleAsignacion);

   // 1. 🏁 LISTENER DE CONFIRMACIÓN OFICIAL
socket.on("assignment_confirmed", (data) => {
  if (data.success) {
    console.log("✅ Confirmación recibida del servidor:", data);
    setEstado(POSITION_STATES.ENCAMINO); 
    detenerSonido();
    toast.success("¡Viaje vinculado! Dirígete al pasajero.");
    setIsAccepting(false);
    setViajeSolicitado(null);

    if (data.pasajero) {
      const pEmail = data.pasajero.email.toLowerCase().trim();
      
      // 🎯 MODIFICACIÓN: Guardamos directamente el payload de respaldo limpio
      // asegurándonos de que la dirección quede firmada en el hilo principal
      const direccionDetectada = data.pasajero.pickupAddress || data.pasajero.direccionOrigen;
      
      setPasajeroAsignado((prev: any) => ({
        ...prev,
        ...data.pasajero,
        pickupAddress: direccionDetectada && direccionDetectada !== "Calculando ubicación..." 
          ? direccionDetectada 
          : (prev?.pickupAddress || "Calle Detectada"),
        email: pEmail
      }));
    }
  }
});


    
// 🚩 AQUÍ PONES EL CANDADO DEL LADO DEL CLIENTE
    socket.on("trip_already_taken", (data: { message: string }) => {
        // 1. Avisamos al chofer con un mensaje claro
        toast.info(data.message, {
            position: "top-center",
            autoClose: 4000,
            icon: <span>⏳</span>
        });

        // 2. IMPORTANTE: Limpiamos el estado para que la solicitud desaparezca
        // y el taxista pueda recibir nuevas alertas de inmediato.
        setViajeSolicitado(null); 
        setEstado(POSITION_STATES.ACTIVO); // Volvemos a estado inicial para que pueda recibir nuevas ofertas
        
        // Si usas algún contador o sonido de alerta, deténlo aquí
    });

// 2. 🔄 LISTENER DE CAMBIO DE ESTADO (BLINDADO)
socket.on("trip_status_update", (data: any) => {
  console.log("🔄 [Socket Test] Cambio de estado recibido:", data);

    // 🛡️ Escudo: ignorar 'buscando' si ya estamos en encurso/finalizado/pendiente
  if (["encurso", "finalizado", "pendiente"].includes(estadoRef.current) && data.estado === "buscando") {
    console.warn("🛡️ Ignorado salto a 'buscando' porque el viaje ya está cerrado o en curso.");
    return;
  }
  
  if (data.estado) {
    setEstado(data.estado);
  }

  // 🚖 CASO A: EL TAXISTA VA EN CAMINO A RECOGER AL PASAJERO
  if (data.estado === "encamino") {
    setPasajeroAsignado((prev: any) => {
      // Prioridad 1: Si el backend por fin mandó los datos limpios en el evento
      if (data.pasajeroAsignado?.pickupAddress && data.pasajeroAsignado.pickupAddress !== "Calculando ubicación...") {
        return data.pasajeroAsignado;
      }
      // Prioridad 2: Si el estado previo tiene la dirección real viva, la retenemos completa
      if (prev?.pickupAddress && prev.pickupAddress !== "Calculando ubicación...") {
        return { ...prev, ...data.pasajeroAsignado, pickupAddress: prev.pickupAddress };
      }
      // Prioridad 3: Si todo falla, buscamos en el historial del objeto de la alerta
      return prev;
    });
  }

  // 🏁 CASO B: EL PASAJERO YA SUBIÓ Y EL VIAJE ESTÁ EN CURSO
  if (data.estado === "encurso") {
    detenerSonido();
    setChatAbierto(false);

    const destinoFinal = getDestinoFinalLatLng(data.pasajeroAsignado || pasajeroAsignadoRef.current);

    // Limpiar cualquier resto de la ruta de recogida y forzar un trazado real hacia destino.
    setGeometriaRuta([]);
    setRutaDestinoFinal(destinoFinal ? [] : []);

    setPasajeroAsignado((prev: any) => ({
      ...prev,
      pickupAddress: prev?.pickupAddress && prev.pickupAddress !== "Calculando ubicación..." 
        ? prev.pickupAddress 
        : "Pasajero a bordo",
      destinationAddress: data.destinationAddress || data.pasajeroAsignado?.destinationAddress || prev?.destinationAddress || "Rumbo al destino..."
    }));

    toast.info("¡Viaje iniciado! Rumbo al destino final.");
  }
});

socket.on("update_trip_path", (data: { lat: number; lng: number }) => {
  setHistorialRuta((prev) => [...prev, [data.lat, data.lng]]);
  setTaxiPos({ lat: data.lat, lng: data.lng, heading: 0 });

  if (estadoRef.current === "encurso") {
    const destinoFinal = getDestinoFinalLatLng(pasajeroAsignadoRef.current);
    if (!destinoFinal) {
      setRutaDestinoFinal([]);
      return;
    }

    // Si la ruta ya no coincide con la calle actual, forzamos recálculo.
    if (rutaDestinoFinal.length === 0) {
      return;
    }
  }
});


    // 🚩 Listener de rehidratación
  socket.on("rehydrate_trip_result", (data) => {
    if (data.success) {
      setEstado(data.estado); 
      setPasajeroAsignado(data.pasajero);
      toast.success("¡Viaje rehidratado con éxito!");
    }
  });

    socket.on("dispatch_timeout", () => {
      if (["encamino", "encurso"].includes(estadoRef.current)) {
        console.warn("🛡️ dispatch_timeout tardío ignorado: viaje ya confirmado.");
        return;
      }
      detenerSonido();
      setPasajeroAsignado(null);
      setEstado(POSITION_STATES.ACTIVO);
    });
    socket.on("trip_cancelled_by_passenger", () => {
      detenerSonido();
      setPasajeroAsignado(null);
      setEstado(POSITION_STATES.ACTIVO);
      setChatAbierto(false);
      setIsAccepting(false);
      setHistorialRuta([]); // Limpiar rastro
      setGeometriaRuta([]); // Limpiar polyline
    });

   socket.on("trip_finished", (payload) => {
   detenerSonido();  
  // 1. Actualizamos los datos del pasajero con la dirección que viene del server
  if (payload?.destinationAddress) {
    setPasajeroAsignado((prev: any) => ({
      ...prev,
      destinationAddress: payload.destinationAddress,
      distancia: payload.distancia || prev?.distancia || null
    }));
  }
  // 2. Cambiamos el estado para que la interfaz sepa que terminó
  setEstado(POSITION_STATES.FINALIZADO); 
  setChatAbierto(false);
  setHistorialRuta([]); 
  setGeometriaRuta([]);
  toast.success("¡Viaje finalizado!");

  // 3. 🕒 ESPERA DE CORTESÍA: Dejamos la info en pantalla 5 segundos
  setTimeout(() => {
    setEstado(POSITION_STATES.ACTIVO);
    setPasajeroAsignado(null);
  }, 5000); 
});

    if (socket.connected) checkStatus();

    return () => {
      socket.off("pasajero_asignado");
      socket.off("assignment_confirmed");
      socket.off("trip_status_update");
      socket.off("update_trip_path");
      socket.off("dispatch_timeout");
      socket.off("rehydrate_trip_result");
      socket.off("trip_cancelled_by_passenger");
      socket.off("trip_finished");
    };
  }, [handleAsignacion, checkStatus, detenerSonido, getDestinoFinalLatLng]);

 useEffect(() => {
  console.log("🔄 useEffect de rastreo disparado");
  console.log("👉 Estado actual:", estado);
  console.log("👉 Longitud geometriaRuta:", geometriaRuta.length);
  console.log("👉 taxiPos:", taxiPos?.lat, taxiPos?.lng);

  if (taxiPos && estado === "encamino" && geometriaRuta.length > 0) {
    const posTaxi = L.latLng(taxiPos.lat!, taxiPos.lng!);

    let indiceMasCercano = 0;
    let distanciaMinima = Infinity;

    geometriaRuta.forEach((punto, index) => {
      const d = posTaxi.distanceTo(punto);
      if (d < distanciaMinima) {
        distanciaMinima = d;
        indiceMasCercano = index;
      }
    });

    console.log("👉 índice más cercano:", indiceMasCercano);
    console.log("👉 distancia mínima a la ruta actual:", distanciaMinima);

    // 🎯 CONDICIÓN 1: El taxista sigue la ruta -> Vamos borrando el camino recorrido
    if (distanciaMinima < 45 && indiceMasCercano > 0) {
      console.log("✅ Avance detectado, borrando puntos hasta índice:", indiceMasCercano);
      setGeometriaRuta(prev => prev.slice(indiceMasCercano));
    } 
    // 🎯 CONDICIÓN 2: Recalcular solo ante desvíos claros, no por jitter normal del GPS.
    // vaciamos la geometría para forzar a la RoutingMachine del JSX a trazar el nuevo camino por la otra calle
    else if (distanciaMinima >= ROUTE_RECALC_THRESHOLD_METERS) {
      console.log("🔄 [Ruta Taxista] Cambio de calle detectado. Vaciando polilínea para recalcular...");
      setGeometriaRuta([]); // Al quedar en cero, se activa automáticamente la RoutingMachine en el mapa
    } else {
      console.log("⚠️ Jitter de GPS dentro del rango tolerado. Conservando ruta actual.");
    }
  } else {
    console.log("⚠️ Condiciones no cumplidas: estado !== 'encamino' o geometriaRuta vacía");
  }
}, [taxiPos, estado]); // 🚩 dependemos de taxiPos y estado

useEffect(() => {
  if (!taxiPos || estado !== "encurso" || rutaDestinoFinal.length === 0) {
    return;
  }

  const posTaxi = L.latLng(Number(taxiPos.lat), Number(taxiPos.lng));
  let indiceMasCercano = 0;
  let distanciaMinima = Infinity;

  rutaDestinoFinal.forEach((punto, index) => {
    const d = posTaxi.distanceTo(punto);
    if (d < distanciaMinima) {
      distanciaMinima = d;
      indiceMasCercano = index;
    }
  });

  if (distanciaMinima < 45 && indiceMasCercano > 0) {
    setRutaDestinoFinal((prev) => prev.slice(indiceMasCercano));
  } else if (distanciaMinima >= ROUTE_RECALC_THRESHOLD_METERS) {
    setRutaDestinoFinal([]);
  }
}, [taxiPos, estado, rutaDestinoFinal.length]);

useEffect(() => {
  if (chatAbierto) {
    setUnreadChatCount(0);
  }
}, [chatAbierto]);

 // --- ACCIONES DEL TAXISTA ---
const aceptarViaje = () => {
  if (isAccepting) return;
  setIsAccepting(true);
  
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
// 🚩 Segurito: Si en 5 segundos el servidor no confirmó, desbloqueamos
  setTimeout(() => {
    setIsAccepting(false);
  }, 5000);
    
  // No cambiamos el estado aquí, esperamos la confirmación del servidor
  // para evitar problemas de sincronización en reconexiones o saltos.
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
  setEstado(POSITION_STATES.ACTIVO);
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

  setEstado(POSITION_STATES.ENCURSO);
  setChatAbierto(false);

  setGeometriaRuta([]);
  setRutaDestinoFinal([]);
  
  if (taxiPos?.lat && taxiPos?.lng) {
    setHistorialRuta([[Number(taxiPos.lat), Number(taxiPos.lng)]]);
  }
};

const finalizarViaje = () => {
  const tEmail = userPosition?.email || localStorage.getItem("email");
  const pEmail = pasajeroAsignado?.email;

  if (!tEmail || !pEmail) {
    setEstado(POSITION_STATES.ACTIVO);
    setPasajeroAsignado(null);
    return;
  }

  socket.emit("end_trip", { 
    pasajeroEmail: pEmail.toLowerCase().trim(), 
    taxistaEmail: tEmail.toLowerCase().trim() 
  });
  
};

   // --- OBJETO DE USUARIO PARA EL MENÚ LATERAL ---
  const user = {
    name: localStorage.getItem("userName") || userPosition?.name || "Taxista",
    email: userPosition?.email || localStorage.getItem("email") || "",
    taxiNumber: userPosition?.taxiNumber || localStorage.getItem("taxiNumber") || "S/N"
  };

  const handleLogout = () => {
    socket.disconnect();
    localStorage.clear();
    window.location.href = "/login";
  };

  const isCompactTripPanel = ["encamino", "encurso"].includes(estado);

  const clampBubbleX = useCallback((x: number) => {
    if (typeof window === "undefined") return x;
    const maxX = window.innerWidth - CHAT_BUBBLE_SIZE - CHAT_BUBBLE_MARGIN;
    return Math.min(Math.max(x, CHAT_BUBBLE_MARGIN), maxX);
  }, []);

  const clampBubbleY = useCallback((y: number) => {
    if (typeof window === "undefined") return y;
    const maxY = window.innerHeight - CHAT_BUBBLE_SIZE - CHAT_BUBBLE_MARGIN;
    return Math.min(Math.max(y, CHAT_BUBBLE_MARGIN), maxY);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (chatBubbleX !== null) return;
    const initialX = window.innerWidth - CHAT_BUBBLE_SIZE - CHAT_BUBBLE_MARGIN;
    setChatBubbleX(initialX);
  }, [chatBubbleX]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (chatBubbleY !== null) return;
    const initialY = window.innerHeight - CHAT_BUBBLE_SIZE - 96;
    setChatBubbleY(clampBubbleY(initialY));
  }, [chatBubbleY, clampBubbleY]);

  useEffect(() => {
    const handleResize = () => {
      if (chatBubbleX === null) return;
      setChatBubbleX((current) => (current === null ? current : clampBubbleX(current)));
      setChatBubbleY((current) => (current === null ? current : clampBubbleY(current)));
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [chatBubbleX, chatBubbleY, clampBubbleX, clampBubbleY]);

  const handleChatBubblePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    event.preventDefault();

    const baseX = chatBubbleX ?? CHAT_BUBBLE_MARGIN;
    const baseY = chatBubbleY ?? CHAT_BUBBLE_MARGIN;
    chatDragRef.current = {
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startBubbleX: baseX,
      startBubbleY: baseY,
      moved: false,
    };

    setIsDraggingChatBubble(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleChatBubblePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!isDraggingChatBubble) return;

    event.preventDefault();

    const deltaX = event.clientX - chatDragRef.current.startPointerX;
    const deltaY = event.clientY - chatDragRef.current.startPointerY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      chatDragRef.current.moved = true;
    }

    const nextX = clampBubbleX(chatDragRef.current.startBubbleX + deltaX);
    const nextY = clampBubbleY(chatDragRef.current.startBubbleY + deltaY);
    setChatBubbleX(nextX);
    setChatBubbleY(nextY);
  };

  const finishChatBubbleDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!isDraggingChatBubble) return;

    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDraggingChatBubble(false);

    if (typeof window === "undefined") return;

    const currentX = chatBubbleX ?? CHAT_BUBBLE_MARGIN;
    const currentY = chatBubbleY ?? CHAT_BUBBLE_MARGIN;
    const snapLeft = CHAT_BUBBLE_MARGIN;
    const snapRight = window.innerWidth - CHAT_BUBBLE_SIZE - CHAT_BUBBLE_MARGIN;
    const middle = window.innerWidth / 2;
    const nextSnap = currentX + CHAT_BUBBLE_SIZE / 2 < middle ? snapLeft : snapRight;

    setChatBubbleX(nextSnap);
    setChatBubbleY(clampBubbleY(currentY));

    if (!chatDragRef.current.moved) {
      setChatAbierto(true);
    }
  };

  const chatPanelOnLeft =
    typeof window !== "undefined" && chatBubbleX !== null
      ? chatBubbleX + CHAT_BUBBLE_SIZE / 2 < window.innerWidth / 2
      : false;

  const chatPanelTop =
    typeof window !== "undefined" && chatBubbleY !== null
      ? Math.min(
          Math.max(chatBubbleY - CHAT_PANEL_HEIGHT + CHAT_BUBBLE_SIZE, CHAT_BUBBLE_MARGIN),
          window.innerHeight - CHAT_PANEL_HEIGHT - CHAT_BUBBLE_MARGIN
        )
      : CHAT_BUBBLE_MARGIN;

return (
  <div className="h-dvh bg-[#0f172a] flex flex-col overflow-hidden font-sans relative text-slate-100">
    <ToastContainer theme="dark" />
    
    {/* OVERLAY OSCURO */}
    {isMenuOpen && (
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1004] transition-opacity"
        onClick={() => setIsMenuOpen(false)}
      />
    )}

    {/* MENÚ LATERAL */}
    <div className={`fixed top-0 left-0 h-full w-72 bg-[#1e293b] z-[1005] transform ${isMenuOpen ? 'translate-x-0' : '-translate-x-full'} transition-transform duration-300 ease-in-out shadow-2xl border-r border-white/5`}>
      <div className="p-8 bg-gradient-to-br from-[#22c55e] to-[#16a34a] text-[#0f172a]">
        <div className="h-16 w-16 bg-white rounded-2xl mb-4 flex items-center justify-center text-2xl shadow-lg font-black">
          {user.name?.charAt(0)}
        </div>
        <h2 className="font-bold text-xl leading-tight">{user.name}</h2>
        <p className="text-xs font-black opacity-70 uppercase tracking-widest">Unidad: {user.taxiNumber}</p>
      </div>

      <nav className="p-4 mt-4 space-y-2">
        <button 
          onClick={() => { setVistaActual('mapa'); setIsMenuOpen(false); }}
          className={`w-full flex items-center gap-4 p-4 rounded-2xl font-bold transition-all ${vistaActual === 'mapa' ? 'bg-[#22c55e] text-[#0f172a]' : 'text-slate-400 hover:bg-white/5'}`}
        >
          <span className="text-xl">📍</span> Mapa en Vivo
        </button>
        
        <button 
          onClick={() => { setVistaActual('historial'); setIsMenuOpen(false); }}
          className={`w-full flex items-center gap-4 p-4 rounded-2xl font-bold transition-all ${vistaActual === 'historial' ? 'bg-[#22c55e] text-[#0f172a]' : 'text-slate-400 hover:bg-white/5'}`}
        >
          <span className="text-xl">📋</span> Mis Viajes
        </button>

        <div className="border-t border-white/5 my-6"></div>

        <button 
          onClick={handleLogout}
          className="w-full flex items-center gap-4 p-4 rounded-2xl font-bold text-red-400 hover:bg-red-500/10 transition-all"
        >
          <span className="text-xl">🚪</span> Cerrar Sesión
        </button>
      </nav>
    </div>

    {/* CONTENIDO DINÁMICO (Mapa o Historial) */}
    <main className="flex-1 w-full relative bg-[#1e293b] overflow-hidden">
      <div className="absolute top-3 left-3 right-3 z-[1200] flex items-center justify-between pointer-events-none">
        <button
          onClick={() => setIsMenuOpen(true)}
          className="pointer-events-auto bg-[#1e293b]/95 p-2.5 rounded-full shadow-lg border border-white/10 active:scale-90 transition-transform"
        >
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <div className="flex items-center gap-2 bg-[#1e293b]/95 px-3 py-1 rounded-full border border-white/10 backdrop-blur-sm">
          <div className={`h-1.5 w-1.5 rounded-full ${taxiPos?.lat && taxiPos?.lng ? 'bg-[#22c55e]' : 'bg-red-500 animate-ping'}`}></div>
          <img src="/icons/taxista.png" alt="Taxi" className="h-3.5 w-3.5 object-contain" />
          <span className="text-[8px] font-black text-slate-300 uppercase tracking-widest">
            ECO-{user.taxiNumber}
          </span>
        </div>
      </div>

      {vistaActual === 'mapa' ? (
        taxiPos?.lat ? (
          <div className="relative w-full h-full">
            
           {/* 🚨 MODAL FLOTANTE DE ACCIÓN MEDIA-ALTA (SOLO CUANDO SE ASIGNA) */}
{estado === "asignado" && pasajeroAsignado ? (
    <div className="absolute inset-x-0 top-6 mx-4 z-[4000] bg-slate-900/95 border-2 border-[#22c55e] rounded-[2.5rem] p-5 shadow-[0_15px_40px_rgba(0,0,0,0.6)] backdrop-blur-md animate-pulse-subtle">
        <div className="flex items-center gap-4 mb-3">
            <div className="w-12 h-12 rounded-2xl bg-[#22c55e] flex items-center justify-center text-2xl shadow-lg">⚡</div>
            <div className="flex-1">
                <p className="text-[9px] font-black uppercase tracking-[0.2em] text-[#22c55e]">¡SOLICITUD INMEDIATA!</p>
                <h3 className="text-lg font-black leading-tight text-white">{pasajeroAsignado.name}</h3>
            </div>
        </div>

        <div className="bg-white/5 p-3 rounded-2xl flex items-start gap-3 mb-4">
            <span className="text-xl">📍</span>
            <div className="flex flex-col w-full">
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Recoger en:</span>
                <p className="text-sm font-bold text-amber-300 leading-tight">
                    {/* 🎯 MULTI-FALLBACK: Intentamos leer todas las variantes de dirección del backend */}
                    {pasajeroAsignado.pickupAddress || pasajeroAsignado.direccion || pasajeroAsignado.address || "Calculando ubicación..."}
                </p>
            </div>
        </div>

                {/* BARRA DE TIEMPO INCORPORADA */}
                <div className="mb-4">
                  <TimerBar duration={15000} onFinish={rechazarViaje} />
                </div>

                {/* BOTÓN ERGONÓMICO GIGANTE PARA EL PULGAR */}
                <div className="grid grid-cols-5 gap-3">
                  <button 
                    onClick={aceptarViaje} 
                    disabled={isAccepting}
                    className={`col-span-3 py-4 rounded-2xl font-black text-xl border-b-4 shadow-lg transition-all active:translate-y-1 ${
                      isAccepting 
                        ? "bg-gray-500 animate-pulse border-gray-700 text-white" 
                        : "bg-[#22c55e] border-[#16a34a] text-[#0f172a] active:bg-[#16a34a]"
                    }`}
                  >
                    {isAccepting ? "⏳ ESPERA..." : "ACEPTAR"}
                  </button>
                  <button 
                    onClick={rechazarViaje} 
                    className="col-span-2 py-4 bg-slate-800 border-b-4 border-slate-950 text-slate-400 rounded-2xl font-black text-xs uppercase tracking-widest active:translate-y-1"
                  >
                    Ignorar
                  </button>
                </div>
              </div>
            ) : null}

            <MapContainer 
              center={[taxiPos.lat, taxiPos.lng]} 
              zoom={15} 
              style={{ height: "100%", width: "100%" }}
              zoomControl={false}
            >
              <MapFixer />
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

              {estado === "encamino" && pasajeroAsignado?.lat && pasajeroAsignado?.lng && geometriaRuta.length === 0 && (
                <Suspense fallback={null}>
                  <RoutingMachine
                    waypoints={[
                      L.latLng(taxiPos.lat, taxiPos.lng),
                      L.latLng(pasajeroAsignado.lat, pasajeroAsignado.lng)
                    ]}
                    onRouteFound={(coords: L.LatLng[]) => setGeometriaRuta(sanitizeRouteTail(coords))}
                  />
                </Suspense>
              )}

              {estado === "encamino" && geometriaRuta.length > 0 && (
                <Polyline positions={geometriaRuta} pathOptions={{ color: 'rgb(245, 33, 65)', weight: 4, lineJoin: 'round' }} />
              )}

              {estado === "encurso" &&
                taxiPos?.lat &&
                taxiPos?.lng &&
                getDestinoFinalLatLng(pasajeroAsignado) &&
                rutaDestinoFinal.length === 0 && (
                  <Suspense fallback={null}>
                    <RoutingMachine
                      waypoints={[
                        L.latLng(Number(taxiPos.lat), Number(taxiPos.lng)),
                        getDestinoFinalLatLng(pasajeroAsignado) as L.LatLng,
                      ]}
                      onRouteFound={(coords: L.LatLng[]) => setRutaDestinoFinal(sanitizeRouteTail(coords))}
                    />
                  </Suspense>
                )}

              {estado === "encurso" && rutaDestinoFinal.length > 0 && (
                <Polyline
                  positions={rutaDestinoFinal}
                  pathOptions={{
                    color: '#06b6d4',
                    weight: 4,
                    opacity: 0.95,
                    lineJoin: 'round',
                    lineCap: 'round',
                  }}
                />
              )}

              {estado === "encurso" && rutaDestinoFinal.length > 0 && (
                <Marker
                  position={[
                    rutaDestinoFinal[rutaDestinoFinal.length - 1].lat,
                    rutaDestinoFinal[rutaDestinoFinal.length - 1].lng,
                  ]}
                  icon={finishFlagIcon}
                >
                  <Popup>Meta del destino</Popup>
                </Marker>
              )}

              {estado === "encurso" && historialRuta.length > 0 && (
                <Polyline positions={historialRuta} pathOptions={{ color: 'rgb(55, 227, 55)', weight: 4 }} />
              )}

              <RotatedMarker position={[taxiPos.lat, taxiPos.lng]} icon={taxistaIcon} rotationAngle={taxiPos.heading || 0}>
                <Popup>Unidad {taxiPos.taxiNumber}</Popup>
              </RotatedMarker>
              
             {pasajeroAsignado?.lat && estado !== "encurso" && (
                <Marker 
                  position={
                    estado === "encamino" && geometriaRuta.length > 0
                      ? [geometriaRuta[geometriaRuta.length - 1].lat, geometriaRuta[geometriaRuta.length - 1].lng]
                      : [Number(pasajeroAsignado.lat), Number(pasajeroAsignado.lng)]
                  }
                  icon={pasajeroIcon}
                />
              )}
            </MapContainer>
          </div>
        ) : (
          <div className="h-full w-full flex items-center justify-center text-slate-500 text-[10px] font-black uppercase italic animate-pulse">🛰️ Sincronizando GPS...</div>
        )
      ) : (
        <div className="h-full w-full bg-[#0f172a] overflow-y-auto pt-4">
          <HistorialViajes email={user.email} />
        </div>
      )}

      {/* Badge de estado flotante */}
      {vistaActual === 'mapa' && (
        <div className="absolute top-14 sm:top-16 right-3 sm:right-4 z-[1000] bg-[#1e293b]/90 backdrop-blur-md px-3 py-1.5 rounded-2xl border border-white/10 flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${estado === "activo" ? "bg-[#22c55e]" : "bg-orange-500 animate-ping"}`}></div>
          <span className="text-[8px] sm:text-[11px] font-black text-white uppercase tracking-widest">{estado}</span>
        </div>
      )}

      {/* CHAT FLOTANTE (ENCAMINO) */}
      {vistaActual === 'mapa' && estado === "encamino" && pasajeroAsignado && (
        <>
          <div
            className={`fixed z-[2000] sm:w-[340px] bg-[#0f172a]/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-md transition-all duration-200 ${chatAbierto ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"}`}
            style={{
              left: chatPanelOnLeft ? "12px" : "auto",
              right: chatPanelOnLeft ? "auto" : "12px",
              top: `${chatPanelTop}px`,
            }}
          >
            <div className="h-11 px-4 flex items-center justify-between bg-white/5 border-b border-white/10">
              <span className="text-[10px] font-black text-white uppercase tracking-widest">Chat con Pasajero</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setChatAbierto(false)}
                  className="text-slate-300 hover:text-white text-xs font-black uppercase tracking-widest"
                >
                  Minimizar
                </button>
                <button
                  onClick={() => setChatAbierto(false)}
                  className="text-slate-400 hover:text-white text-sm font-black"
                  aria-label="Cerrar chat"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="h-[260px]">
              <ChatBox
                toEmail={pasajeroAsignado.email}
                userName={`Taxi Valles`}
                onIncomingMessage={() => {
                  if (!chatAbierto) {
                    setUnreadChatCount((prev) => Math.min(prev + 1, 99));
                  }
                }}
              />
            </div>
          </div>

          <button
            onPointerDown={handleChatBubblePointerDown}
            onPointerMove={handleChatBubblePointerMove}
            onPointerUp={finishChatBubbleDrag}
            onPointerCancel={finishChatBubbleDrag}
            style={{
              left: `${chatBubbleX ?? CHAT_BUBBLE_MARGIN}px`,
              top: `${chatBubbleY ?? CHAT_BUBBLE_MARGIN}px`,
            }}
            className={`fixed z-[2000] h-[52px] w-[52px] bg-[#22c55e] text-[#0f172a] rounded-full border-b-4 border-[#15803d] shadow-2xl font-black text-lg flex items-center justify-center active:translate-y-1 select-none touch-none transition-opacity duration-150 ${chatAbierto ? "opacity-0 pointer-events-none" : "opacity-100"} ${unreadChatCount > 0 ? "animate-pulse ring-4 ring-[#22c55e]/45" : ""}`}
            title="Chat con pasajero"
            aria-label="Abrir chat con pasajero"
            data-dragging={isDraggingChatBubble ? "true" : "false"}
          >
            💬
            {unreadChatCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 border-2 border-[#0f172a] text-[9px] leading-none font-black flex items-center justify-center text-white">
                {unreadChatCount > 9 ? "9+" : unreadChatCount}
              </span>
            )}
          </button>
        </>
      )}
    </main>
  
    {/* PANEL DE ACCIONES INFERIOR (Solo para EnCamino, EnCurso o Buscando) */}
    <div className="w-full max-w-md mx-auto bg-[#1e293b] rounded-t-[2.5rem] shadow-[0_-25px_60px_rgba(0,0,0,0.5)] shrink-0 z-[1001] relative border-t border-white/5">
      <div className="absolute top-3 left-1/2 -translate-x-1/2 w-12 h-1 bg-slate-700 rounded-full"></div>

      {pasajeroAsignado && estado !== "asignado" ? (
        <div className="flex flex-col">
          <div className={isCompactTripPanel ? "px-4 pt-4 pb-1" : "px-6 pt-6 pb-2"}>
            <div className={isCompactTripPanel ? "p-3 rounded-[1.5rem] bg-[#0f172a]/50 border border-white/5 flex flex-col gap-2" : "p-5 rounded-[2.5rem] bg-[#0f172a]/50 border border-white/5 flex flex-col gap-3"}>
              <div className={isCompactTripPanel ? "flex items-center gap-3" : "flex items-center gap-4"}>
                <div className={isCompactTripPanel ? "w-9 h-9 rounded-xl bg-white flex items-center justify-center text-lg shadow-lg" : "w-12 h-12 rounded-2xl bg-white flex items-center justify-center text-2xl shadow-lg"}>👤</div>
                <div className="flex-1">
                  <p className={isCompactTripPanel ? "text-[7px] font-black uppercase tracking-[0.18em] text-slate-500" : "text-[8px] font-black uppercase tracking-[0.2em] text-slate-500"}>
                    {estado === "encurso" ? "Viaje Activo" : "Trayecto de Recogida"}
                  </p>
                  <h3 className={isCompactTripPanel ? "text-sm font-black leading-tight text-white" : "text-lg font-black leading-tight text-white"}>{pasajeroAsignado.name}</h3>
                </div>
              </div>

              <div className={isCompactTripPanel ? "p-2 rounded-xl flex items-start gap-2 bg-white/5" : "p-3 rounded-2xl flex items-start gap-3 bg-white/5"}>
                <span className={isCompactTripPanel ? "text-base" : "text-xl"}>{estado === "encurso" ? "🚖" : "📍"}</span>
                <div className="flex flex-col">
                  <span className={isCompactTripPanel ? "text-[8px] font-black uppercase tracking-widest text-slate-400" : "text-[9px] font-black uppercase tracking-widest text-slate-400"}>
                    {estado === "encurso" ? "Destino:" : "Punto de recogida:"}
                  </span>
                  <p className={isCompactTripPanel ? "text-xs font-bold text-white leading-tight truncate max-w-[240px]" : "text-sm font-bold text-white leading-tight"}>
                    {estado === "encurso" 
                      ? (pasajeroAsignado.destinationAddress || "Rumbo al destino...") 
                      : (pasajeroAsignado.pickupAddress || "Calculando ubicación...")
                    }
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* BOTONES OPERATIVOS EN RUTA */}
          <div className={isCompactTripPanel ? "p-4 pb-6" : "p-6 pb-10"}>
            {estado === "encamino" && (
              <button onClick={confirmarAbordo} className={isCompactTripPanel ? "w-full py-3 bg-white text-[#0f172a] rounded-xl font-black text-base flex items-center justify-center gap-2 border-b-4 border-slate-300 active:translate-y-1 transition-all shadow-lg" : "w-full py-4 bg-white text-[#0f172a] rounded-2xl font-black text-lg flex items-center justify-center gap-3 border-b-4 border-slate-300 active:translate-y-1 transition-all shadow-lg"}>
                📍 CONFIRMAR ABORDO
              </button>
            )}

            {estado === "encurso" && (
              <button onClick={finalizarViaje} className={isCompactTripPanel ? "w-full py-3 bg-red-600 text-white rounded-xl font-black text-base border-b-4 border-red-900 shadow-xl active:translate-y-1 transition-all" : "w-full py-4 bg-red-600 text-white rounded-2xl font-black text-lg border-b-4 border-red-900 shadow-xl active:translate-y-1 transition-all"}>
                🏁 FINALIZAR SERVICIO
              </button>
            )}
          </div>
        </div>
      ) : estado === "asignado" ? (
        /* PANEL INFERIOR VACÍO O CON ESPERA MIENTRAS LA ALERTA ESTÁ ARRIBA */
        <div className="py-8 flex flex-col items-center justify-center">
          <p className="text-slate-400 text-xs font-black uppercase tracking-widest animate-pulse">⚡ Responde arriba ⚡</p>
        </div>
      ) : (
        /* ESTADO BUSCANDO DEFAULT */
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