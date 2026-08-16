import React, { Suspense, lazy, useState, useEffect, useMemo, useRef, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet"; // 🚩 Importamos Polyline
import { toast, ToastContainer } from "react-toastify";
import L, { icon } from 'leaflet';
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
import { taxistaIcon, pasajeroIcon, banderaIcon, taxiValles } from "../utils/icons";
import { calcularHeading } from "../utils/heading"; // Función para calcular el heading entre dos puntos
import { POSITION_STATES, STATE_GROUPS, PositionState } from "../constants/states";
import { shouldAcceptStateTransition } from "../utils/socketStateGuard";
import { showToastOnce } from "../utils/toastGuard";

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
const ROUTE_RECALC_THRESHOLD_METERS = 45;
const OFFROAD_TAIL_THRESHOLD_METERS = 22;
const OFFER_RESPONSE_TIMEOUT_MS = 15000;


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

const hasRealFinalDestination = (payload?: Partial<Payload> | null) => {
  if (!payload) return false;

  const hasCoords =
    payload.destinationLat !== null &&
    payload.destinationLat !== undefined &&
    payload.destinationLng !== null &&
    payload.destinationLng !== undefined &&
    Number.isFinite(Number(payload.destinationLat)) &&
    Number.isFinite(Number(payload.destinationLng));

  if (!hasCoords) return false;

  return true;
};

const formatShortAddress = (value?: string | null) => {
  if (!value) return "Rumbo al destino...";

  const raw = String(value).trim();
  if (!raw) return "Rumbo al destino...";

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return "Rumbo al destino...";

  const stateNames = new Set([
    "aguascalientes",
    "baja california",
    "baja california sur",
    "campeche",
    "chiapas",
    "chihuahua",
    "ciudad de méxico",
    "cdmx",
    "coahuila",
    "colima",
    "durango",
    "guanajuato",
    "guerrero",
    "hidalgo",
    "jalisco",
    "méxico",
    "mexico",
    "mex",
    "michoacán",
    "michoacan",
    "morelos",
    "nayarit",
    "nuevo león",
    "nuevo leon",
    "oaxaca",
    "puebla",
    "querétaro",
    "queretaro",
    "quintana roo",
    "san luis potosí",
    "san luis potosi",
    "slp",
    "sinaloa",
    "sonora",
    "tabasco",
    "tamaulipas",
    "tlaxcala",
    "veracruz",
    "yucatán",
    "yucatan",
    "zacatecas",
  ]);

  const filtered = parts.filter((part) => {
    const normalized = part.toLowerCase();
    if (/^\d{5}(-\d{4})?$/.test(part)) return false;
    if (stateNames.has(normalized)) return false;
    if (["mexico", "méxico", "usa", "united states", "estados unidos"].includes(normalized)) return false;
    return true;
  });

  if (filtered.length <= 3) {
    return filtered.join(", ") || raw;
  }

  return filtered.slice(0, 3).join(", ");
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
  const [canRespondToOffer, setCanRespondToOffer] = useState(true);
  const [excludedEmails, setExcludedEmails] = useState<string[]>([]);
  const [chatAbierto, setChatAbierto] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [chatBubbleX, setChatBubbleX] = useState<number | null>(null);
  const [chatBubbleY, setChatBubbleY] = useState<number | null>(null);
  const [isDraggingChatBubble, setIsDraggingChatBubble] = useState(false);
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false);

  // 🚩 ESTADO PARA EL RASTRO DEL VIAJE
  const [historialRuta, setHistorialRuta] = useState<L.LatLngExpression[]>([]);
  // 🚩 ESTADO PARA LA LÍNEA QUE SE VA BORRANDO (Hacia el pasajero)
const [geometriaRuta, setGeometriaRuta] = useState<L.LatLng[]>([]);
  const [rutaDestinoFinal, setRutaDestinoFinal] = useState<L.LatLng[]>([]);
  const [routeRefreshToken, setRouteRefreshToken] = useState(0);

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
  const tripSessionActiveRef = useRef(false);
  const acceptanceTimerRef = useRef<number | null>(null);
  const answeredOfferRequestIdsRef = useRef(new Set<string>());
  const activeOfferRequestIdRef = useRef<string | null>(null);
  const lastClosedOfferRequestIdRef = useRef<string | null>(null);
  const ignoreOffersUntilRef = useRef(0);
  const pushRehydrateRef = useRef<{ pasajero: string | null; taxista: string | null; requestId: string | null; autoAccept: boolean }>({
    pasajero: null,
    taxista: null,
    requestId: null,
    autoAccept: false,
  });
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [vistaActual, setVistaActual] = useState('mapa'); // 'mapa' o 'historial'
  const [isAccepting, setIsAccepting] = useState(false);

  useEffect(() => {
    if (estado === "finalizado" || estado === "activo") {
      const timeout = window.setTimeout(() => setGeometriaRuta([]), 300);
      return () => window.clearTimeout(timeout);
    }
  }, [estado]);

  useEffect(() => {
    if (estado === POSITION_STATES.ENCURSO) {
      return;
    }

    const estadosLimpios: PositionState[] = [POSITION_STATES.ACTIVO, POSITION_STATES.FINALIZADO, POSITION_STATES.CANCELADO];
if (estadosLimpios.includes(estado)) {
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
  const requestId = params.get("requestId");
  const autoAccept = params.get("autoAccept");
  const isPushFlow = Boolean(pasajero && taxista && requestId);

  pushRehydrateRef.current = {
    pasajero,
    taxista,
    requestId,
    autoAccept: autoAccept === "true",
  };

  if (isPushFlow) {
    console.log("🔄 Rehidratando viaje desde notificación:", { pasajero, requestId, autoAccept });
    
    // Limpiar la URL inmediatamente para evitar reintentos si el usuario recarga
    window.history.replaceState({}, document.title, window.location.pathname);

    if (autoAccept === "true") {
      setIsAccepting(true);
      setEstado(POSITION_STATES.ENCAMINO); // Feedback visual inmediato

      // 🎯 NUEVO: Si el socket ya está conectado, aceptamos proactivamente 
      // en lugar de solo pedir rehidratación.
      if (socket.connected) {
        console.log("🚀 Auto-aceptando proactivamente vía Socket...");
        socket.emit("taxi_response", {
          requestEmail: pasajero,
          accepted: true,
          requestId: requestId,
        });
      } else {
        // Si no está conectado, emitimos para cuando se conecte
        socket.emit("request_rehydrate", { requestId, forceAccept: true });
      }
    } else {
      // Si es solo un clic en la notificación (sin auto-aceptar), solo pedimos datos
      if (socket.connected) {
        socket.emit("request_rehydrate", { requestId });
      }
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []); // Se ejecuta solo una vez al montar


 // --- EFFECT DE SUSCRIPCIÓN PUSH OPTIMIZADO ---
useEffect(() => {
  const miEmail = userPosition?.email || localStorage.getItem("email");
  if (!miEmail) return;

  const gestionarSuscripcion = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn("❌ Este dispositivo no soporta Notificaciones Push.");
      return;
    }

    // Verificar permiso del navegador antes de intentar suscribir
    if (Notification.permission === 'denied') {
      console.warn("🚫 Permisos de notificación denegados por el usuario.");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      
      if (!subscription) {
        console.log("⚠️ Re-suscribiendo al Push Manager...");
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      }

      if (subscription) {
        console.log(`🔄 Sincronizando token push para: ${miEmail}`);
        await axiosInstance.post(`/api/save-subscription`, {
          email: miEmail.toLowerCase().trim(),
          subscription: subscription
        });
        console.log("✅ Suscripción Push sincronizada.");
      }
    } catch (err: any) {
      console.error("❌ Error en el ciclo de suscripción Push:", err);
    }
  };

  gestionarSuscripcion();
}, [userPosition?.email]); // Dependencia clara y segura

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

  const resetSolicitudActiva = useCallback(() => {
    detenerSonido();
    tripSessionActiveRef.current = false;
    if (acceptanceTimerRef.current) {
      window.clearTimeout(acceptanceTimerRef.current);
      acceptanceTimerRef.current = null;
    }
    setIsAccepting(false);
    setCanRespondToOffer(false);
    setViajeSolicitado(null);
    setPasajeroAsignado(null);
    setExcludedEmails([]);
    setChatAbierto(false);
    setHistorialRuta([]);
    setGeometriaRuta([]);
    setRutaDestinoFinal([]);
    lastClosedOfferRequestIdRef.current = activeOfferRequestIdRef.current;
    activeOfferRequestIdRef.current = null;
    ignoreOffersUntilRef.current = Date.now() + 3000;
    setEstado(POSITION_STATES.ACTIVO);
  }, [detenerSonido]);

  const handleResetTaxistaState = useCallback((payload?: { message?: string; estado?: string }) => {
    if (payload?.estado && payload.estado !== POSITION_STATES.ACTIVO) {
      setEstado(payload.estado as PositionState);
    } else {
      setEstado(POSITION_STATES.ACTIVO);
    }

    setCanRespondToOffer(false);
    setIsAccepting(false);
    setViajeSolicitado(null);
    setPasajeroAsignado(null);
    setExcludedEmails([]);
    setChatAbierto(false);
    setHistorialRuta([]);
    setGeometriaRuta([]);
    setRutaDestinoFinal([]);
    lastClosedOfferRequestIdRef.current = activeOfferRequestIdRef.current;
    activeOfferRequestIdRef.current = null;
    ignoreOffersUntilRef.current = Date.now() + 3000;
    tripSessionActiveRef.current = false;
    setRouteRefreshToken((prev) => prev + 1);
  }, []);

  const expireOfferResponse = useCallback(() => {
    if ([POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO, POSITION_STATES.ASIGNADO].includes(estadoRef.current as any)) {
      return;
    }

    const passengerEmail = pasajeroAsignadoRef.current?.email?.toLowerCase().trim();
    const requestId = pasajeroAsignadoRef.current?.requestId;

    if (passengerEmail && tripSessionActiveRef.current && canRespondToOffer) {
      if (requestId) {
        answeredOfferRequestIdsRef.current.add(String(requestId));
      }
      socket.emit("taxi_response", {
        requestEmail: passengerEmail,
        accepted: false,
        excludedEmails,
      });
    }

    setCanRespondToOffer(false);
    resetSolicitudActiva();
  }, [canRespondToOffer, excludedEmails, resetSolicitudActiva]);

  useEffect(() => {
    audioRef.current = new Audio("/sounds/alerta_taxi.mp3");
    if (audioRef.current) {
      audioRef.current.loop = true;
      audioRef.current.load();
    }
    return () => {
      if (acceptanceTimerRef.current) {
        window.clearTimeout(acceptanceTimerRef.current);
        acceptanceTimerRef.current = null;
      }
      detenerSonido();
    };
  }, [detenerSonido]);

// --- 🛰️ GEOLOCALIZACIÓN OPTIMIZADA Y BLINDADA CON HEADING REAL (TAXISTA) ---
useGeolocation(
  {
    email: userPosition?.email || localStorage.getItem("email") || "",
    name: localStorage.getItem("userName") || userPosition?.name || "Taxista",
    role: "taxista",
    taxiNumber: userPosition?.taxiNumber || localStorage.getItem("taxiNumber") || "",
 // 🎯 CAST SEGURO: Le decimos a TS que confiamos en que el string es válido para el frontend
    estado: estado as import("../types/Positions").EstadoUsuario, 
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

  const requestTripRehydrate = useCallback(() => {
    const miEmail = userPosition?.email || localStorage.getItem("email");
    const miRole = localStorage.getItem("role");

    if (!miEmail || !miRole) return;

    if ([POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO, POSITION_STATES.ASIGNADO].includes(estadoRef.current as any)) {
      setRouteRefreshToken((prev) => prev + 1);
    }

    if (socket.connected) {
      socket.emit("reproducir_estado_viaje", { email: miEmail.toLowerCase().trim(), role: miRole });
      socket.emit("request_rehydrate", {});
    } else {
      socket.connect();
    }
  }, [userPosition?.email]);

  // 🚩 REHIDRATACIÓN AUTOMÁTICA AL CARGAR Y AL VOLVER AL PRIMER PLANO
  useEffect(() => {
    const onConnectRehydrate = () => {
      const { pasajero, taxista, requestId } = pushRehydrateRef.current;
      if (pasajero && taxista) {
        console.log("🔄 Rehidratación de respaldo tras reconexión de socket");
        socket.emit("request_rehydrate", { requestId });
      }
      requestTripRehydrate();
    };

    const onResume = () => {
      if (document.visibilityState === "visible") {
        requestTripRehydrate();
      }
    };

    checkStatus();
    onConnectRehydrate();

    socket.on("connect", checkStatus);
    socket.on("connect", onConnectRehydrate);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);

    return () => {
      socket.off("connect", checkStatus);
      socket.off("connect", onConnectRehydrate);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, [checkStatus, requestTripRehydrate]);

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
  const requestId = String(rawData.requestId || data.requestId || "").trim();

  if (requestId && answeredOfferRequestIdsRef.current.has(requestId)) {
    console.warn("🛡️ Oferta ignorada: ya respondimos a esta solicitud.", requestId);
    return;
  }

  if (requestId && !tripSessionActiveRef.current && lastClosedOfferRequestIdRef.current === requestId) {
    console.warn("🛡️ Oferta vieja ignorada tras el reset local de esta solicitud.", requestId);
    return;
  }

  if (ignoreOffersUntilRef.current > Date.now()) {
    console.warn("🛡️ Oferta ignorada por cooldown post-rechazo/reset.", requestId || incomingEmail);
    return;
  }

  if (!tripSessionActiveRef.current && !["encamino", "encurso"].includes(estadoActual)) {
    tripSessionActiveRef.current = true;
  }

  setCanRespondToOffer(true);

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
    if (requestId) {
      lastClosedOfferRequestIdRef.current = null;
      activeOfferRequestIdRef.current = requestId;
    }

    // 2. ACTUALIZACIÓN DE ESTADOS
    // Limpiamos el email por si trae la "k" extra o espacios
    const pEmail = incomingEmail;
    setPasajeroAsignado((prev:  Payload | null) => ({ 
      ...prev,
      ...rawData, 
      email: pEmail, 
      attempt: data.attempt,
      pasajeroEmail: rawData.pasajeroEmail || pEmail,
      pasajeroLat: rawData.pasajeroLat || rawData.lat,
      pasajeroLng: rawData.pasajeroLng || rawData.lng,
      distancia: rawData.distancia || null,
      destinationLat: rawData.destinationLat ?? prev?.destinationLat ?? null,
      destinationLng: rawData.destinationLng ?? prev?.destinationLng ?? null,
      destinationAddress: rawData.destinationAddress ?? prev?.destinationAddress ?? "Rumbo al destino...",
      pickupAddress: rawData.pickupAddress || prev?.pickupAddress || "Calculando ubicación..."
    }));
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

    const handleTripDestinationUpdated = (data: any) => {
      const passengerEmail = pasajeroAsignadoRef.current?.email?.toLowerCase().trim();
      const incomingEmail = String(data?.pasajeroEmail || "").toLowerCase().trim();
      if (incomingEmail && passengerEmail && incomingEmail !== passengerEmail) return;

      setPasajeroAsignado((prev: Payload | null) => {
        if (!prev) return prev;

        const nextLat = data?.destinationLat ?? prev.destinationLat ?? null;
        const nextLng = data?.destinationLng ?? prev.destinationLng ?? null;
        const nextAddress = data?.destinationAddress ?? prev.destinationAddress ?? "Rumbo al destino...";
        const sameDestination = prev.destinationLat === nextLat && prev.destinationLng === nextLng;

        if (sameDestination) {
          return prev;
        }

        return {
          ...prev,
          destinationLat: nextLat,
          destinationLng: nextLng,
          destinationAddress: nextAddress,
        } as Payload;
      });

      const nextLat = data?.destinationLat ?? pasajeroAsignadoRef.current?.destinationLat ?? null;
      const nextLng = data?.destinationLng ?? pasajeroAsignadoRef.current?.destinationLng ?? null;
      const sameDestination = pasajeroAsignadoRef.current?.destinationLat === nextLat && pasajeroAsignadoRef.current?.destinationLng === nextLng;
      const isInProgressTrip = estadoRef.current === POSITION_STATES.ENCURSO;

      if (!sameDestination && nextLat !== null && nextLng !== null && !isInProgressTrip) {
        setRouteRefreshToken((prev) => prev + 1);
      }
    };

    socket.on("pasajero_asignado", handleAsignacion);
    socket.on("trip_destination_updated", handleTripDestinationUpdated);
// 1. 🏁 LISTENER DE CONFIRMACIÓN OFICIAL
socket.on("assignment_confirmed", (data) => {
  if (!tripSessionActiveRef.current) {
    console.warn("🛡️ assignment_confirmed ignorado: la sesión local ya fue cerrada.");
    return;
  }

  if (data.success) {
    console.log("✅ Confirmación recibida del servidor:", data);
    
    // 🎯 LIMPIEZA CRÍTICA: El servidor respondió con éxito, matamos el timer de seguridad
    // para que no se ejecute el fallback de expiración innecesariamente.
    if (acceptanceTimerRef.current) {
      window.clearTimeout(acceptanceTimerRef.current);
      acceptanceTimerRef.current = null;
    }

    setEstado(POSITION_STATES.ENCAMINO); 
    detenerSonido();
    setIsAccepting(false); // Liberamos el bloqueo de clics
    setViajeSolicitado(null);

    showToastOnce("taxista:assignment-confirmed", () => {
      toast.success("¡Viaje vinculado! Dirígete al pasajero.");
    }, { cooldownMs: 4000 });

    if (data.pasajero) {
      const pEmail = data.pasajero.email.toLowerCase().trim();
      
      // 🎯 MODIFICACIÓN: Guardamos directamente el payload de respaldo limpio
      // asegurándonos de que la dirección quede firmada en el hilo principal
      const direccionDetectada = data.pasajero.pickupAddress || data.pasajero.direccionOrigen;
      
      setPasajeroAsignado((prev: Payload | null) => ({
        ...prev,
        ...data.pasajero,
        pickupAddress: direccionDetectada && direccionDetectada !== "Calculando ubicación..." 
          ? direccionDetectada 
          : (prev?.pickupAddress || "Calle Detectada"),
        email: pEmail
      }));
    }
  } else {
    // Si el servidor rechaza la aceptación (ej. otro taxista fue más rápido)
    if (acceptanceTimerRef.current) {
      window.clearTimeout(acceptanceTimerRef.current);
      acceptanceTimerRef.current = null;
    }
    setIsAccepting(false);
    toast.error(data.message || "No se pudo confirmar el viaje.");
    resetSolicitudActiva(); // Limpiamos todo para volver a estar disponibles
  }
});

    
// 🚩 AQUÍ PONES EL CANDADO DEL LADO DEL CLIENTE
    const handleLateOffer = (data: { message?: string } = {}) => {
      showToastOnce("taxista:trip-already-taken", () => {
        toast.info(data.message || "El viaje ya fue tomado por otro conductor.", {
            position: "top-center",
            autoClose: 4000,
            icon: <span>⏳</span>
        });
      }, { cooldownMs: 4000 });

      setCanRespondToOffer(false);
      resetSolicitudActiva();
    };

    socket.on("trip_already_taken", handleLateOffer);
    socket.on("push_late", handleLateOffer);
    socket.on("reset_estado_taxista", handleResetTaxistaState);

// 2. 🔄 LISTENER DE CAMBIO DE ESTADO (BLINDADO)
socket.on("trip_status_update", (data: any) => {
  console.log("🔄 [Socket Test] Cambio de estado recibido:", data);

  const nextEstado = String(data.estado || "").toLowerCase().trim();
  const normalizedNextEstado = nextEstado === "buscando" ? POSITION_STATES.ACTIVO : nextEstado;

  if (!tripSessionActiveRef.current && ["encamino", "encurso", "asignado"].includes(normalizedNextEstado)) {
    console.warn("🛡️ trip_status_update ignorado: la sesión local ya fue cerrada.", { nextEstado });
    return;
  }

  if (!shouldAcceptStateTransition(estadoRef.current, normalizedNextEstado as PositionState)) {
    console.warn("🛡️ Estado del taxista ignorado por guard de sincronización:", { current: estadoRef.current, next: normalizedNextEstado });
    return;
  }

    // 🛡️ Escudo: ignorar 'buscando' si ya estamos en encurso/finalizado/pendiente
  if (["encurso", "finalizado", "pendiente"].includes(estadoRef.current) && normalizedNextEstado === POSITION_STATES.ACTIVO) {
    console.warn("🛡️ Ignorado salto a activo porque el viaje ya está cerrado o en curso.");
    return;
  }
  
  if (normalizedNextEstado) {
    setEstado(normalizedNextEstado as PositionState);
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

    const pasajeroConDestinoReal = data.pasajeroAsignado || pasajeroAsignadoRef.current;
    const destinoFinal = hasRealFinalDestination(pasajeroConDestinoReal)
      ? getDestinoFinalLatLng(pasajeroConDestinoReal)
      : null;

    setPasajeroAsignado((prev: any) => ({
      ...prev,
      pickupAddress: prev?.pickupAddress && prev.pickupAddress !== "Calculando ubicación..." 
        ? prev.pickupAddress 
        : "Pasajero a bordo",
      destinationAddress: data.destinationAddress || data.pasajeroAsignado?.destinationAddress || prev?.destinationAddress || "Rumbo al destino..."
    }));

    showToastOnce("taxista:trip-started", () => {
      toast.info("¡Viaje iniciado! Rumbo al destino final.");
    }, { cooldownMs: 4000 });
  }
});

// Reemplaza el listener update_trip_path con este:
socket.on("update_trip_path", (data: { lat: number; lng: number }) => {
  // 🎯 CORRECCIÓN TIPO: Usar L.latLng para evitar el error de TypeScript
  const nuevaCoord = L.latLng(data.lat, data.lng);
  setHistorialRuta((prev) => [...prev, nuevaCoord]);

  // 🎯 CORRECCIÓN LÓGICA: Preservar el heading calculado por useGeolocation
  // No lo sobrescribas con 0, o el ícono del taxi perderá su orientación real
  setTaxiPos((prev) => ({
    lat: data.lat,
    lng: data.lng,
    heading: prev?.heading || 0, 
  }));

  if (estadoRef.current === POSITION_STATES.ENCURSO) {
    const destinoFinal = hasRealFinalDestination(pasajeroAsignadoRef.current)
      ? getDestinoFinalLatLng(pasajeroAsignadoRef.current)
      : null;
      
    if (!destinoFinal) {
      setRutaDestinoFinal([]);
      return;
    }

    // 🎯 CORRECCIÓN CRÍTICA: Si la ruta está vacía, hay que forzar el recálculo
    if (rutaDestinoFinal.length === 0) {
      setRouteRefreshToken((prev) => prev + 1); // Esto activa el RoutingMachine
    }
  }
});


    // 🚩 Listener de rehidratación
  socket.on("rehydrate_trip_result", (data) => {
    if (!data?.success) {
      resetSolicitudActiva();
      return;
    }

    const nextState = String(data?.estado || "").toLowerCase().trim();
    const isInactiveTrip = ["activo", "pendiente", "buscando", "cancelado", "finalizado"].includes(nextState);

    if (isInactiveTrip || !data?.pasajero) {
      resetSolicitudActiva();
      showToastOnce("taxista:rehydrated-cancelled", () => {
        toast.info("La solicitud ya no está activa. Quedaste disponible.");
      }, { cooldownMs: 4000 });
      return;
    }

    setEstado(nextState as PositionState);
    setPasajeroAsignado(data.pasajero);
    tripSessionActiveRef.current = true;
    showToastOnce("taxista:rehydrated", () => {
      toast.success("¡Viaje rehidratado con éxito!");
    }, { cooldownMs: 4000 });
  });

    socket.on("dispatch_timeout", () => {
      if (["encamino", "encurso"].includes(estadoRef.current)) {
        console.warn("🛡️ dispatch_timeout tardío ignorado: viaje ya confirmado.");
        return;
      }
      resetSolicitudActiva();
    });
    socket.on("dispatch_revoked", (payload: any) => {
      console.warn("🛡️ Asignación revocada por el servidor:", payload);
      setCanRespondToOffer(false);
      resetSolicitudActiva();
      showToastOnce("taxista:dispatch-revoked", () => {
        toast.info(payload?.message || "La asignación fue revocada.", {
          position: "top-center",
          autoClose: 4000,
        });
      }, { cooldownMs: 4000 });
    });
    socket.on("trip_cancelled_by_passenger", () => {
      resetSolicitudActiva();
      showToastOnce("taxista:trip-cancelled", () => {
        toast.info("El pasajero canceló la solicitud.");
      }, { cooldownMs: 4000 });
    });

   socket.on("trip_finished", (payload) => {
   detenerSonido();  
   tripSessionActiveRef.current = false;
   if (acceptanceTimerRef.current) {
     window.clearTimeout(acceptanceTimerRef.current);
     acceptanceTimerRef.current = null;
   }
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
  setRutaDestinoFinal([]);
  showToastOnce("taxista:trip-finished", () => {
    toast.success("¡Viaje finalizado!");
  }, { cooldownMs: 4000 });

  // 3. 🕒 ESPERA DE CORTESÍA: Dejamos la info en pantalla 5 segundos
  setTimeout(() => {
    setEstado(POSITION_STATES.ACTIVO);
    setPasajeroAsignado(null);
    setRutaDestinoFinal([]);
    setGeometriaRuta([]);
    setHistorialRuta([]);
  }, 5000); 
});

    if (socket.connected) checkStatus();

    return () => {
      socket.off("pasajero_asignado");
      socket.off("assignment_confirmed");
      socket.off("trip_status_update");
      socket.off("update_trip_path");
      socket.off("dispatch_timeout");
      socket.off("dispatch_revoked");
      socket.off("push_late");
      socket.off("trip_already_taken");
      socket.off("rehydrate_trip_result");
      socket.off("trip_destination_updated");
      socket.off("trip_cancelled_by_passenger");
      socket.off("trip_finished");
      socket.off("reset_estado_taxista");
    };
  }, [handleAsignacion, checkStatus, detenerSonido, getDestinoFinalLatLng, handleResetTaxistaState, resetSolicitudActiva]);

  useEffect(() => {
    if (!taxiPos) {
      return;
    }

    // 🚩 CASO 1: Taxista en camino al pasajero (Recortar ruta de aproximación)
    if (estado === POSITION_STATES.ENCAMINO && geometriaRuta.length > 2) {
      const posTaxi = L.latLng(Number(taxiPos.lat), Number(taxiPos.lng));
      let indiceMasCercano = 0;
      let distanciaMinima = Infinity;

      geometriaRuta.forEach((punto, index) => {
        const d = posTaxi.distanceTo(punto);
        if (d < distanciaMinima) {
          distanciaMinima = d;
          indiceMasCercano = index;
        }
      });

      if (distanciaMinima < 45 && indiceMasCercano > 0) {
        setGeometriaRuta((prev) => prev.slice(indiceMasCercano));
      } else if (distanciaMinima >= ROUTE_RECALC_THRESHOLD_METERS) {
        setGeometriaRuta([]);
        setRouteRefreshToken((prev) => prev + 1);
      }
      return;
    }

    // 🚩 CASO 2: Viaje en curso (Recortar ruta hacia el destino final)
    if (estado === POSITION_STATES.ENCURSO && rutaDestinoFinal.length > 2) {
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
        setRouteRefreshToken((prev) => prev + 1);
      }
    }
  }, [taxiPos, estado, geometriaRuta, rutaDestinoFinal]); // 🎯 CORRECCIÓN: Quitamos .length

useEffect(() => {
  if (chatAbierto) {
    setUnreadChatCount(0);
  }
}, [chatAbierto]);

 // --- ACCIONES DEL TAXISTA ---

const aceptarViaje = (event?: React.MouseEvent<HTMLButtonElement> | React.PointerEvent<HTMLButtonElement>) => {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  // 🛡️ Guardias de seguridad
  if (!tripSessionActiveRef.current || isAccepting || !canRespondToOffer || !pasajeroAsignado?.email) {
    if (!pasajeroAsignado?.email) console.error("❌ Error: No hay email de pasajero para aceptar.");
    return;
  }

  setIsAccepting(true);
  tripSessionActiveRef.current = true;
  ignoreOffersUntilRef.current = Date.now() + 1500;
  detenerSonido();

  if (pasajeroAsignado?.requestId) {
    answeredOfferRequestIdsRef.current.add(String(pasajeroAsignado.requestId));
  }
  
  // 1. Emitimos la aceptación al servidor
  socket.emit("taxi_response", { 
    requestEmail: pasajeroAsignado.email.toLowerCase().trim(), 
    accepted: true, 
    excludedEmails 
  });

  // 2. Configuramos el timer de seguridad (fallback por si el servidor no responde)
  if (acceptanceTimerRef.current) {
    window.clearTimeout(acceptanceTimerRef.current);
  }
  
  acceptanceTimerRef.current = window.setTimeout(() => {
    const estadosActivos: PositionState[] = [
      POSITION_STATES.ENCAMINO,
      POSITION_STATES.ENCURSO,
      POSITION_STATES.ASIGNADO
    ];

    // Si el servidor ya confirmó y cambió el estado, cancelamos el timer y no hacemos nada.
    if (estadosActivos.includes(estadoRef.current)) {
      if (acceptanceTimerRef.current) {
        window.clearTimeout(acceptanceTimerRef.current);
        acceptanceTimerRef.current = null;
      }
      return;
    }

    // Si pasaron 15s y el estado NO cambió, asumimos que el servidor no respondió y expiramos.
    console.warn("⚠️ Timeout de aceptación: El servidor no respondió a tiempo.");
    expireOfferResponse();
  }, OFFER_RESPONSE_TIMEOUT_MS);
};

const rechazarViaje = (event?: React.MouseEvent<HTMLButtonElement> | React.PointerEvent<HTMLButtonElement>) => {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (!pasajeroAsignado?.email || isAccepting || !canRespondToOffer) return;

  setIsAccepting(true);
  ignoreOffersUntilRef.current = Date.now() + 3000;
  detenerSonido();
  
  if (pasajeroAsignado?.requestId) {
    answeredOfferRequestIdsRef.current.add(String(pasajeroAsignado.requestId));
  }

  // 1. Emitimos el rechazo
  socket.emit("taxi_response", { 
    requestEmail: pasajeroAsignado.email.toLowerCase().trim(), 
    accepted: false, 
    excludedEmails 
  });

  // 2. Limpiamos todo el estado local (esto ya incluye setIsAccepting(false))
  resetSolicitudActiva();
};

const confirmarAbordo = () => {
  const tEmail = userPosition?.email || localStorage.getItem("email");
  const pEmail = pasajeroAsignado?.email;

  if (!tripSessionActiveRef.current || !tEmail || !pEmail) {
    toast.error("No hay un viaje activo para confirmar.");
    return;
  }

  // 🛡️ Actualización optimista para feedback visual inmediato
  setEstado(POSITION_STATES.ENCURSO);
  setChatAbierto(false);

  if (taxiPos?.lat && taxiPos?.lng) {
    setHistorialRuta([L.latLng(Number(taxiPos.lat), Number(taxiPos.lng))]);
  }

  // Emitimos al servidor para que valide la relación y oficialice el estado
  socket.emit("passenger_on_board", { 
    taxistaEmail: tEmail.toLowerCase().trim(), 
    pasajeroEmail: pEmail.toLowerCase().trim() 
  });
};

const finalizarViaje = () => {
  const tEmail = userPosition?.email || localStorage.getItem("email");
  const pEmail = pasajeroAsignado?.email;

  if (!tripSessionActiveRef.current || !tEmail || !pEmail) {
    resetSolicitudActiva();
    return;
  }

  // 🛡️ Aquí NO hacemos actualización optimista del estado. 
  // Dejamos que el servidor procese el cobro/cierre y nos envíe "trip_finished".
  // Esto evita que el viaje se marque como finalizado si hay un error en el servidor.
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
  const hasSystemTripActive = [POSITION_STATES.PREASIGNADO, POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO].includes(estado as any);

  const destinoFinalMarkerPosition = useMemo<L.LatLngExpression | null>(() => {
    if (!hasRealFinalDestination(pasajeroAsignado)) {
      return null;
    }

    const destinoExplicito = getDestinoFinalLatLng(pasajeroAsignado);
    if (destinoExplicito) {
      return [destinoExplicito.lat, destinoExplicito.lng] as L.LatLngExpression;
    }

    if (rutaDestinoFinal.length > 0) {
      const ultimo = rutaDestinoFinal[rutaDestinoFinal.length - 1];
      return [ultimo.lat, ultimo.lng] as L.LatLngExpression;
    }

    return null;
  }, [pasajeroAsignado, rutaDestinoFinal]);

  const routeOriginForDestination = useMemo<L.LatLng | null>(() => {
    if (estado === POSITION_STATES.ENCURSO && taxiPos?.lat && taxiPos?.lng) {
      return L.latLng(Number(taxiPos.lat), Number(taxiPos.lng));
    }

    if (pasajeroAsignado?.lat && pasajeroAsignado?.lng) {
      return L.latLng(Number(pasajeroAsignado.lat), Number(pasajeroAsignado.lng));
    }

    return null;
  }, [estado, taxiPos?.lat, taxiPos?.lng, pasajeroAsignado?.lat, pasajeroAsignado?.lng]);

  const destinationRouteKey = useMemo(() => {
    const destino = getDestinoFinalLatLng(pasajeroAsignado);
    const origen = pasajeroAsignado?.lat && pasajeroAsignado?.lng
      ? L.latLng(Number(pasajeroAsignado.lat), Number(pasajeroAsignado.lng))
      : null;

    return `${origen?.lat ?? "na"}-${origen?.lng ?? "na"}-${destino?.lat ?? "na"}-${destino?.lng ?? "na"}-${routeRefreshToken}`;
  }, [pasajeroAsignado?.lat, pasajeroAsignado?.lng, pasajeroAsignado?.destinationLat, pasajeroAsignado?.destinationLng, routeRefreshToken]);

  const statusBadgeConfig = useMemo(() => {
    switch (estado) {
      case POSITION_STATES.ACTIVO:
        return {
          dot: "bg-[#22c55e]",
          label: "ACTIVO",
          container: "bg-[#1e293b]/90 border-white/10 text-white",
        };
      case POSITION_STATES.OCUPADO:
        return {
          dot: "bg-amber-400",
          label: "OCUPADO",
          container: "bg-amber-500/20 border-amber-400/40 text-amber-100",
        };
      case POSITION_STATES.INACTIVO:
        return {
          dot: "bg-slate-500",
          label: "INACTIVO",
          container: "bg-slate-700/60 border-slate-500/40 text-slate-200",
        };
      default:
        return {
          dot: "bg-orange-500 animate-ping",
          label: estado.toUpperCase(),
          container: "bg-[#1e293b]/90 border-white/10 text-white",
        };
    }
  }, [estado]);

  const cambiarEstadoManual = useCallback((nextState: PositionState) => {
    if (hasSystemTripActive) return;

    socket.emit("update_driver_status", { estado: nextState }, (response: { success: boolean; estado?: string; message?: string }) => {
      if (!response?.success || !response.estado) {
        toast.error(response?.message || "No se pudo cambiar el estado del taxista.");
        return;
      }

      setEstado(response.estado as PositionState);
      setIsStatusMenuOpen(false);
      toast.success(`Estado actualizado a ${response.estado}.`);
    });
  }, [hasSystemTripActive]);

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

    const handleSessionReplaced = () => {
      setEstado(POSITION_STATES.ACTIVO);
      setViajeSolicitado(null);
      setPasajeroAsignado(null);
      setHistorialRuta([]);
      setGeometriaRuta([]);
      setRutaDestinoFinal([]);
      setChatAbierto(false);
      setIsAccepting(false);
      setIsStatusMenuOpen(false);
      setRouteRefreshToken((prev) => prev + 1);
      toast.warn("Se abrió otra sesión para esta cuenta. Se limpió el estado del viaje.", { autoClose: 3500 });
    };

    window.addEventListener("socket-session-replaced", handleSessionReplaced as EventListener);
    return () => window.removeEventListener("socket-session-replaced", handleSessionReplaced as EventListener);
  }, []);

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

  useEffect(() => {
    if (hasSystemTripActive) {
      setIsStatusMenuOpen(false);
    }
  }, [hasSystemTripActive]);

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
      <div className={`fixed top-0 left-0 h-full w-72 bg-[#1e293b] z-[1005] transform ${isMenuOpen ? 'translate-x-0' : '-translate-x-full'} transition-transform duration-300 ease-in-out shadow-2xl border-r border-white/10`}>
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
            <span className="text-[8px] font-black text-slate-300 uppercase tracking-widest">
              ECO-{user.taxiNumber}
            </span>
          </div>
        </div>

        {vistaActual === 'mapa' ? (
          taxiPos?.lat ? (
            <div className="relative w-full h-full">
              
              {/* 🚨 MODAL FLOTANTE DE ACCIÓN MEDIA-ALTA */}
              {estado === POSITION_STATES.ASIGNADO && pasajeroAsignado && canRespondToOffer ? (
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
                        {pasajeroAsignado.pickupAddress || pasajeroAsignado.direccion || pasajeroAsignado.address || "Calculando ubicación..."}
                      </p>
                    </div>
                  </div>

                  <div className="mb-4">
                    <TimerBar duration={OFFER_RESPONSE_TIMEOUT_MS} onFinish={expireOfferResponse} />
                  </div>

                  <div className="grid grid-cols-5 gap-3">
                    <button 
                      type="button"
                      onPointerDown={(event) => aceptarViaje(event)}
                      onClick={(event) => aceptarViaje(event)}
                      disabled={isAccepting || !canRespondToOffer || estado !== POSITION_STATES.ASIGNADO}
                      className={`col-span-3 py-4 rounded-2xl font-black text-xl border-b-4 shadow-lg transition-all active:translate-y-1 ${
                        isAccepting || !canRespondToOffer || estado !== POSITION_STATES.ASIGNADO
                          ? "bg-gray-500 animate-pulse border-gray-700 text-white cursor-not-allowed" 
                          : "bg-[#22c55e] border-[#16a34a] text-[#0f172a] active:bg-[#16a34a]"
                      }`}
                    >
                      {isAccepting ? "⏳ ESPERA..." : "ACEPTAR"}
                    </button>
                    <button 
                      type="button"
                      onPointerDown={(event) => rechazarViaje(event)}
                      onClick={(event) => rechazarViaje(event)}
                      disabled={isAccepting || !canRespondToOffer || estado !== POSITION_STATES.ASIGNADO}
                      className={`col-span-2 py-4 rounded-2xl font-black text-xs uppercase tracking-widest active:translate-y-1 transition-all ${
                        (isAccepting || !canRespondToOffer || estado !== POSITION_STATES.ASIGNADO) 
                          ? "bg-slate-700 text-slate-500 cursor-not-allowed" 
                          : "bg-slate-800 border-b-4 border-slate-950 text-slate-400"
                      }`}
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

                {estado === POSITION_STATES.ENCAMINO && pasajeroAsignado?.lat && pasajeroAsignado?.lng && geometriaRuta.length === 0 && (
                  <Suspense fallback={null}>
                    <RoutingMachine
                      waypoints={[
                        L.latLng(taxiPos.lat, taxiPos.lng),
                        L.latLng(pasajeroAsignado.lat, pasajeroAsignado.lng)
                      ]}
                      onRouteFound={(coords: L.LatLng[]) => {
                        setGeometriaRuta(sanitizeRouteTail(coords));
                      }}
                    />
                  </Suspense>
                )}

                {(estado === POSITION_STATES.ENCAMINO || estado === POSITION_STATES.ENCURSO) &&
                  hasRealFinalDestination(pasajeroAsignado) &&
                  getDestinoFinalLatLng(pasajeroAsignado) &&
                  rutaDestinoFinal.length === 0 && (
                    <Marker
                      position={getDestinoFinalLatLng(pasajeroAsignado)!}
                      icon={banderaIcon}
                    >
                      <Popup>Destino del pasajero</Popup>
                    </Marker>
                  )}

                {(estado === POSITION_STATES.ENCAMINO || estado === POSITION_STATES.ENCURSO) && geometriaRuta.length > 0 && (
                  <Polyline positions={geometriaRuta} pathOptions={{ color: 'rgb(245, 33, 65)', weight: 4, lineJoin: 'round' }} />
                )}

                {(estado === POSITION_STATES.ENCAMINO || estado === POSITION_STATES.ENCURSO) &&
                  pasajeroAsignado?.lat &&
                  pasajeroAsignado?.lng &&
                  hasRealFinalDestination(pasajeroAsignado) &&
                  getDestinoFinalLatLng(pasajeroAsignado) && (
                    <Suspense fallback={null}>
                      <RoutingMachine
                        key={destinationRouteKey}
                        waypoints={[
                          routeOriginForDestination as L.LatLng,
                          getDestinoFinalLatLng(pasajeroAsignado) as L.LatLng,
                        ]}
                        onRouteFound={(coords: L.LatLng[]) => {
                          setRutaDestinoFinal(sanitizeRouteTail(coords));
                        }}
                      />
                    </Suspense>
                  )}

                {(estado === POSITION_STATES.ENCAMINO || estado === POSITION_STATES.ENCURSO) && hasRealFinalDestination(pasajeroAsignado) && rutaDestinoFinal.length > 0 && (
                  <Polyline
                    positions={rutaDestinoFinal}
                    pathOptions={{
                      color: '#22c55e',
                      weight: 5,
                      opacity: 0.95,
                      lineJoin: 'round',
                      lineCap: 'round',
                    }}
                  />
                )}

                {(estado === POSITION_STATES.ENCAMINO || estado === POSITION_STATES.ENCURSO) && destinoFinalMarkerPosition && (
                  <Marker
                    position={destinoFinalMarkerPosition}
                    icon={banderaIcon}
                  >
                    <Popup>Meta del destino</Popup>
                  </Marker>
                )}

                {estado === POSITION_STATES.ENCURSO && historialRuta.length > 0 && (
                  <Polyline positions={historialRuta} pathOptions={{ color: 'rgb(55, 227, 55)', weight: 4 }} />
                )}

                <RotatedMarker position={[taxiPos.lat, taxiPos.lng]} icon={taxistaIcon} rotationAngle={taxiPos.heading || 0}>
                  <Popup>Unidad {taxiPos.taxiNumber}</Popup>
                </RotatedMarker>
                
                {pasajeroAsignado?.lat && 
                 estado !== POSITION_STATES.FINALIZADO && 
                 estado !== POSITION_STATES.ACTIVO && 
                 estado !== POSITION_STATES.CANCELADO && (
                  <Marker 
                    position={
                      estado === POSITION_STATES.ENCAMINO && geometriaRuta.length > 0
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
          <div className="absolute top-14 sm:top-16 right-3 sm:right-4 z-[1000]">
            <button
              type="button"
              onClick={() => !hasSystemTripActive && setIsStatusMenuOpen((prev) => !prev)}
              className={`backdrop-blur-md px-3 py-1.5 rounded-2xl border flex items-center gap-2 ${statusBadgeConfig.container} ${hasSystemTripActive ? "cursor-default opacity-90" : "cursor-pointer"}`}
            >
              <div className={`h-2 w-2 rounded-full ${statusBadgeConfig.dot}`}></div>
              <span className="text-[8px] sm:text-[11px] font-black uppercase tracking-widest">{statusBadgeConfig.label}</span>
              {!hasSystemTripActive && <span className="text-[10px] text-white/70">▾</span>}
            </button>

            {isStatusMenuOpen && !hasSystemTripActive && (
              <div className="mt-2 rounded-2xl border border-white/10 bg-[#0f172a]/95 p-2 shadow-2xl backdrop-blur-md">
                <button
                  type="button"
                  onClick={() => cambiarEstadoManual(POSITION_STATES.ACTIVO)}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[10px] font-black uppercase tracking-widest text-white hover:bg-white/5"
                >
                  <span className="h-2 w-2 rounded-full bg-[#22c55e]"></span>
                  Activo
                </button>
                <button
                  type="button"
                  onClick={() => cambiarEstadoManual(POSITION_STATES.OCUPADO)}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[10px] font-black uppercase tracking-widest text-white hover:bg-white/5"
                >
                  <span className="h-2 w-2 rounded-full bg-amber-400"></span>
                  Ocupado
                </button>
                <button
                  type="button"
                  onClick={() => cambiarEstadoManual(POSITION_STATES.INACTIVO)}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[10px] font-black uppercase tracking-widest text-white hover:bg-white/5"
                >
                  <span className="h-2 w-2 rounded-full bg-slate-500"></span>
                  Inactivo
                </button>
              </div>
            )}
          </div>
        )}

        {/* CHAT FLOTANTE (ENCAMINO) */}
        {vistaActual === 'mapa' && estado === POSITION_STATES.ENCAMINO && pasajeroAsignado && (
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
    
      {/* PANEL DE ACCIONES INFERIOR */}
      <div className="w-full max-w-md mx-auto bg-[#1e293b] rounded-t-[2.5rem] shadow-[0_-25px_60px_rgba(0,0,0,0.5)] shrink-0 z-[1001] relative border-t border-white/5">
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-12 h-1 bg-slate-700 rounded-full"></div>

        {pasajeroAsignado && estado !== POSITION_STATES.ASIGNADO ? (
          <div className="flex flex-col">
            <div className={isCompactTripPanel ? "px-4 pt-4 pb-1" : "px-6 pt-6 pb-2"}>
              <div className={isCompactTripPanel ? "p-3 rounded-[1.5rem] bg-[#0f172a]/50 border border-white/5 flex flex-col gap-2" : "p-5 rounded-[2.5rem] bg-[#0f172a]/50 border border-white/5 flex flex-col gap-3"}>
                <div className={isCompactTripPanel ? "flex items-center gap-3" : "flex items-center gap-4"}>
                  <div className={isCompactTripPanel ? "w-9 h-9 rounded-xl bg-white flex items-center justify-center text-lg shadow-lg" : "w-12 h-12 rounded-2xl bg-white flex items-center justify-center text-2xl shadow-lg"}>👤</div>
                  <div className="flex-1">
                    <p className={isCompactTripPanel ? "text-[7px] font-black uppercase tracking-[0.18em] text-slate-500" : "text-[8px] font-black uppercase tracking-[0.2em] text-slate-500"}>
                      {estado === POSITION_STATES.ENCURSO ? "Viaje Activo" : "Trayecto de Recogida"}
                    </p>
                    <h3 className={isCompactTripPanel ? "text-sm font-black leading-tight text-white" : "text-lg font-black leading-tight text-white"}>{pasajeroAsignado.name}</h3>
                  </div>
                </div>

                <div className={isCompactTripPanel ? "p-2 rounded-xl flex items-start gap-2 bg-white/5" : "p-3 rounded-2xl flex items-start gap-3 bg-white/5"}>
                  <span className={isCompactTripPanel ? "text-base" : "text-xl"}>{estado === POSITION_STATES.ENCURSO || (estado === POSITION_STATES.ENCAMINO && hasRealFinalDestination(pasajeroAsignado)) ? "🚖" : "📍"}</span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className={isCompactTripPanel ? "text-[8px] font-black uppercase tracking-widest text-slate-400" : "text-[9px] font-black uppercase tracking-widest text-slate-400"}>
                      {estado === POSITION_STATES.ENCURSO || (estado === POSITION_STATES.ENCAMINO && hasRealFinalDestination(pasajeroAsignado)) ? "Destino:" : "Punto de recogida:"}
                    </span>
                    {estado === POSITION_STATES.ENCURSO || (estado === POSITION_STATES.ENCAMINO && hasRealFinalDestination(pasajeroAsignado)) ? (
                      <div className="address-marquee">
                        <div className="address-marquee-track">
                          <span>{formatShortAddress(pasajeroAsignado.destinationAddress)}</span>
                          <span aria-hidden="true">{formatShortAddress(pasajeroAsignado.destinationAddress)}</span>
                        </div>
                      </div>
                    ) : (
                      <p className={isCompactTripPanel ? "text-xs font-bold text-white leading-tight truncate max-w-[240px]" : "text-sm font-bold text-white leading-tight"}>
                        {pasajeroAsignado.pickupAddress || "Calculando ubicación..."}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* BOTONES OPERATIVOS EN RUTA (BLINDADOS CON DISABLED) */}
            <div className={isCompactTripPanel ? "p-4 pb-6" : "p-6 pb-10"}>
              {estado === POSITION_STATES.ENCAMINO && (
                <button 
                  onClick={confirmarAbordo} 
                  disabled={!pasajeroAsignado}
                  className={`w-full py-4 bg-white text-[#0f172a] rounded-2xl font-black text-lg flex items-center justify-center gap-3 border-b-4 border-slate-300 active:translate-y-1 transition-all shadow-lg ${!pasajeroAsignado ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  📍 CONFIRMAR ABORDO
                </button>
              )}

              {estado === POSITION_STATES.ENCURSO && (
                <button 
                  onClick={finalizarViaje} 
                  disabled={!pasajeroAsignado}
                  className={`w-full py-4 bg-red-600 text-white rounded-2xl font-black text-lg border-b-4 border-red-900 shadow-xl active:translate-y-1 transition-all ${!pasajeroAsignado ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  🏁 FINALIZAR SERVICIO
                </button>
              )}
            </div>
          </div>
        ) : estado === POSITION_STATES.ASIGNADO ? (
          <div className="py-8 flex flex-col items-center justify-center">
            <p className="text-slate-400 text-xs font-black uppercase tracking-widest animate-pulse">⚡ Responde arriba ⚡</p>
          </div>
        ) : (
          <div className="w-full py-8 px-4 flex items-center justify-center">
            <div className="flex w-full max-w-[560px] items-center justify-center gap-3 sm:gap-6">
              <div className="flex-shrink-0 rounded-[2rem] bg-white/5 p-3 shadow-[0_10px_30px_rgba(0,0,0,0.25)] border border-white/10">
                <img
                  src={taxiValles.options.iconUrl}
                  alt="Taxi Icon"
                  className="w-24 h-24 sm:w-28 sm:h-28 object-contain"
                />
              </div>

              <div className="flex flex-col items-center justify-center">
                <div className="relative flex h-28 w-28 sm:h-32 sm:w-32 items-center justify-center rounded-full border-[5px] border-[#22c55e] bg-gradient-to-br from-[#0f172a] via-[#111827] to-[#0f172a] shadow-[0_0_30px_rgba(34,197,94,0.35)] animate-bounce">
                  <div className="absolute inset-2 rounded-full border border-[#22c55e]/30" />
                  <span className="px-2 text-center text-[0.95rem] sm:text-[1.05rem] font-black uppercase tracking-[0.25em] leading-none text-white">
                    LIBRE
                  </span>
                </div>

                <div className="mt-4 text-center">
                  <h2 className="text-[1.05rem] sm:text-[1.25rem] font-black text-white uppercase italic tracking-[0.18em]">
                    VALLES<span className="ml-1 text-[#22c55e]">CONECTA</span>
                  </h2>
                  <p className="mt-1 text-[9px] sm:text-[10px] font-bold uppercase tracking-[0.28em] text-slate-400 animate-pulse">
                    Esperando señal de viaje
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TaxistaView;