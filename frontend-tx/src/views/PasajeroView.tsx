import React, {
  Suspense,
  lazy,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { socket } from "../lib/socket";
import { useTravel } from "../context/TravelContext";
import { useNavigate } from "react-router-dom";
import { useGeolocation } from "../hooks/useGeolocation";
import { Payload, ViajeEstado } from "../types/Payload";
import { EstadoUsuario } from "../types/Positions";
import { ChatBox } from "../components/ChatBox";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { taxistaIcon, pasajeroIcon } from "../utils/icons";
import RotatedMarker from "../components/RotatedMarker";
import { calcularHeading } from "../utils/heading";
import { TRIP_STATES } from "../constants/states";
import { shouldAcceptStateTransition } from "../utils/socketStateGuard";
import { showToastOnce } from "../utils/toastGuard";
import { getDistanceKm } from "../helpers/getDistanceKm";
import { calcularTarifaPorDistancia } from "../utils/fare";

const RoutingMachine = lazy(() =>
  import("../components/RoutingMachine").then((module) => ({
    default: module.RoutingMachine,
  })),
);

/**
 * 🎯 Mantiene el mapa siguiendo al objetivo (el taxi durante el viaje).
 *
 * `MapContainer` sólo usa `center` al montarse: durante un viaje el taxi se
 * aleja del encuadre inicial y el usuario se queda con la sensación de que "no
 * avanza" porque el marcador se sale de la pantalla. Este componente reencuadra
 * cuando el objetivo se aleja más del umbral.
 */
const MapAutoFollow: React.FC<{
  lat: number | null;
  lng: number | null;
  activo: boolean;
}> = ({ lat, lng, activo }) => {
  const map = useMap();
  // Al mover el mapa a mano se pausa el seguimiento para no pelear con el dedo.
  const pausaHastaRef = useRef(0);

  useEffect(() => {
    const handleDragStart = () => {
      pausaHastaRef.current = Date.now() + 15000;
    };

    map.on("dragstart", handleDragStart);

    return () => {
      map.off("dragstart", handleDragStart);
    };
  }, [map]);

  useEffect(() => {
    if (!activo) return;
    if (lat === null || lng === null) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (Date.now() < pausaHastaRef.current) return;

    const objetivo = L.latLng(Number(lat), Number(lng));

    if (map.getCenter().distanceTo(objetivo) < 60) return;

    map.setView(objetivo, map.getZoom(), { animate: true });
  }, [activo, lat, lng, map]);

  return null;
};

const OFFROAD_TAIL_THRESHOLD_METERS = 22;
const ROUTE_RECALC_THRESHOLD_METERS = 120;
const PREVIEW_ORIGIN_RECALC_METERS = 40;
const PREVIEW_DEST_RECALC_METERS = 6;
const DESTINATION_STORAGE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Ventana en la que se prefiere el canal en vivo (`update_trip_path`) sobre el
 * respaldo `taxi_moved`. Ambos llevan ya la coordenada real, así que basta con
 * unos segundos para evitar parpadeos sin dejar el marcador ciego.
 */
const LIVE_FIX_PREFERENCE_MS = 6000;

/**
 * Estados en los que el pasajero mantiene visible su ruta al destino
 * (pasajero → destino). Antes sólo se calculaba en `pendiente` con el selector
 * abierto: al solicitar el taxi la polilínea desaparecía y no había forma de
 * reconstruirla hasta que el viaje entraba en curso.
 */
const ESTADOS_CON_RUTA_DESTINO: ViajeEstado[] = [
  "pendiente",
  "buscando",
  "preasignado",
  "asignado",
  "encamino",
];

/** Desplazamiento mínimo del pin de destino para aceptar un arrastre. */
const DESTINATION_MIN_MOVE_METERS = 80;

/** Frecuencia máxima de cambios de destino por arrastre del pin. */
const DESTINATION_CHANGE_MIN_INTERVAL_MS = 8000;

// 💵 La tabla de tarifas vive en `src/utils/fare.ts` (regla suave: 1 peso
// cada 100 metros). Aquí sólo se consume.

const isValidCoordinatePair = (lat: number, lng: number) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
};

const sanitizeRouteTail = (coords: L.LatLng[]) => {
  if (!coords || coords.length < 3) return coords;

  const last = coords[coords.length - 1];
  const prev = coords[coords.length - 2];
  const tailDistance = prev.distanceTo(last);

  // Recorta el último salto si cae fuera de calle para evitar parpadeo visual.
  if (tailDistance >= OFFROAD_TAIL_THRESHOLD_METERS) {
    return coords.slice(0, -1);
  }

  return coords;
};

const destinationMarkerIcon = L.divIcon({
  className: "",
  html: `
    <div style="position:relative;width:30px;height:42px;filter:drop-shadow(0 6px 10px rgba(0,0,0,0.28));">
      <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:30px;height:30px;background:#22c55e;border:2px solid #ffffff;border-radius:50% 50% 50% 0;transform-origin:center;rotate:-45deg;"></div>
      <div style="position:absolute;left:50%;top:9px;transform:translateX(-50%);width:10px;height:10px;background:#ffffff;border-radius:9999px;"></div>
    </div>
  `,
  iconSize: [30, 42],
  iconAnchor: [15, 40],
});

const PasajeroView: React.FC = () => {
  const CHAT_BUBBLE_SIZE = 52;
  const CHAT_BUBBLE_MARGIN = 12;

  const { userPosition, setUserPosition, taxiPos, setTaxiPos, logout } =
    useTravel();
  const navigate = useNavigate();
  const [estado, setEstado] = useState<ViajeEstado>(TRIP_STATES.PENDIENTE);
  const [taxistaAsignado, setTaxistaAsignado] = useState<Payload | null>(null);
  const [searchFlowActivo, setSearchFlowActivo] = useState(false);
  const [chatAbierto, setChatAbierto] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [chatBubbleX, setChatBubbleX] = useState<number | null>(null);
  const [isDraggingChatBubble, setIsDraggingChatBubble] = useState(false);
  const [destinationQuery, setDestinationQuery] = useState("");
  const [destinoConfirmado, setDestinoConfirmado] = useState(false);
  const [destinationAddress, setDestinationAddress] = useState("");
  const destinationAddressRef = useRef("");
  const [destinationLat, setDestinationLat] = useState<number | null>(null);
  const [destinationLng, setDestinationLng] = useState<number | null>(null);
  const destinationLatRef = useRef<number | null>(destinationLat);
  const destinationLngRef = useRef<number | null>(destinationLng);

  // Mantener las referencias sincronizadas con el estado actual.
  destinationLatRef.current = destinationLat;
  destinationLngRef.current = destinationLng;
  const [destinoColapsado, setDestinoColapsado] = useState(false);
  const [selectorDestinoAbierto, setSelectorDestinoAbierto] = useState(false);
  const [isSearchingDestination, setIsSearchingDestination] = useState(false);
  const [historialRuta, setHistorialRuta] = useState<L.LatLngExpression[]>([]);
  const [geometriaRuta, setGeometriaRuta] = useState<L.LatLngExpression[]>([]);
  const [rutaDestinoPreview, setRutaDestinoPreview] = useState<
    L.LatLngExpression[]
  >([]);
  const [routeRefreshToken, setRouteRefreshToken] = useState(0);
  const [rutaDestinoEnCurso, setRutaDestinoEnCurso] = useState<
    L.LatLngExpression[]
  >([]);
  const [tarifaEstimada, setTarifaEstimada] = useState<number | null>(null);
  const [distanciaEstimadaKm, setDistanciaEstimadaKm] = useState<number | null>(
    null,
  );
  const [distanciaRutaMapboxKm, setDistanciaRutaMapboxKm] = useState<
    number | null
  >(null);
  const [isRehydrating, setIsRehydrating] = useState(false);

  const limpiarDireccionDestino = (direccion: string) => {
    if (!direccion) return "";

    return direccion
      .replace(/\bC\.?\s*P\.?\s*\d{5}\b/gi, "")
      .replace(/\b\d{5}\b/g, "")
      .replace(/\bSLP\b/gi, "")
      .replace(/\bSan\s+Luis\s+Potos[ií]\b/gi, "")
      .replace(/\bEstado\s+de\s+San\s+Luis\s+Potos[ií]\b/gi, "")
      .replace(/\bMéxico\b/gi, "")
      .replace(/,\s*,/g, ",")
      .replace(/\s+,/g, ",")
      .replace(/,\s*$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  };

  // REFS CENTRALIZADAS - Evitan closures obsoletos en listeners
  const taxistaAsignadoRef = useRef<Payload | null>(null);
  const estadoRef = useRef<ViajeEstado>(TRIP_STATES.PENDIENTE);
  const tripSessionActiveRef = useRef(false);
  const lastBackPressedRef = useRef(0);
  const taxiPosRef = useRef<any>(null);
  const userPositionRef = useRef<any>(null);
  const previewRouteSeedRef = useRef<{
    origin: L.LatLng | null;
    destination: L.LatLng | null;
  }>({
    origin: null,
    destination: null,
  });
  const hasSeededDestinationRef = useRef(false);
  const chatDragRef = useRef({
    startPointerX: 0,
    startBubbleX: 0,
    moved: false,
  });

  const lastRouteCalculationPositionRef = useRef<{
    lat: number;
    lng: number;
  } | null>(null);

  /**
   * Marca de tiempo de la última coordenada recibida por el canal en vivo
   * (`update_trip_path`, que el backend relaya tal cual). Impide que
   * `taxi_moved` —que relee la posición guardada en la BD— sobrescriba una
   * coordenada más fresca y clave el marcador en una posición vieja.
   */
  const lastLiveTaxiFixAtRef = useRef(0);

  /**
   * Anti-tormenta: limita la frecuencia con la que se fuerza el recálculo de la
   * ruta al destino cuando el taxi aparece lejos de la ruta calculada.
   */
  const lastDestinoRecalcAtRef = useRef(0);

  /** Antispam del log de diagnóstico de posiciones recibidas. */
  const lastPosLogAtRef = useRef(0);

  /** Último cambio de destino aceptado (limita el arrastre accidental). */
  const lastDestinationChangeAtRef = useRef(0);

  /** Estado de conexión del socket, para avisar en pantalla si se cae. */
  const [socketConectado, setSocketConectado] = useState<boolean>(
    () => socket?.connected ?? false,
  );

  // Sincronización de refs (un solo efecto para todas)
  useEffect(() => {
    taxistaAsignadoRef.current = taxistaAsignado;
  }, [taxistaAsignado]);
  useEffect(() => {
    estadoRef.current = estado;
  }, [estado]);
  useEffect(() => {
    tripSessionActiveRef.current =
      estado === TRIP_STATES.ASIGNADO ||
      estado === TRIP_STATES.ENCAMINO ||
      estado === TRIP_STATES.ENCURSO;

    console.log("🛡️ PASAJERO TRIP SESSION", {
      estado,
      tripSessionActive: tripSessionActiveRef.current,
    });

    if (!tripSessionActiveRef.current) {
      lastBackPressedRef.current = 0;
    }
  }, [estado]);
  useEffect(() => {
    taxiPosRef.current = taxiPos;
  }, [taxiPos]);
  useEffect(() => {
    userPositionRef.current = userPosition;
  }, [userPosition]);

  /**
   * 🔌 Aviso de conexión: si el socket se cae, el mapa se queda congelado sin
   * ninguna pista para el usuario (en la prueba del 4-nov el socket del
   * pasajero murió por `ping timeout` y el taxi siguió enviando coordenadas
   * que nadie recibía). Con esto la app lo dice en pantalla.
   */
  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => setSocketConectado(true);
    const handleDisconnect = () => setSocketConectado(false);

    setSocketConectado(socket.connected);

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
    };
  }, []);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true;

    const ensureHistoryEntry = () => {
      try {
        window.history.pushState(
          { isTripActive: true },
          "",
          window.location.pathname + window.location.search,
        );
      } catch (e) {
        console.warn(
          "⚠️ No se pudo ajustar el historial para guard de retroceso:",
          e,
        );
      }
    };

    ensureHistoryEntry();

    const handlePopState = (_event: PopStateEvent) => {
      console.log("🛡️ PASAJERO POPSTATE", {
        estado: estadoRef.current,
        tripSessionActive: tripSessionActiveRef.current,
        lastBackPressed: lastBackPressedRef.current,
        hash: window.location.hash,
        href: window.location.href,
        standalone,
      });

      if (!tripSessionActiveRef.current) {
        console.log("🛡️ POPSTATE ignorado: viaje no activo");
        return;
      }

      const now = Date.now();

      console.log("🛡️ POPSTATE viaje activo", {
        elapsed: now - lastBackPressedRef.current,
      });

      if (now - lastBackPressedRef.current < 2000) {
        console.log("🛡️ SEGUNDO ATRÁS: permitir salida");
        ensureHistoryEntry();
        return;
      }

      lastBackPressedRef.current = now;

      console.log("🛡️ PRIMER ATRÁS: mostrar advertencia");

      toast.info("Presiona atrás nuevamente para salir", {
        toastId: "double-back-exit",
        autoClose: 2000,
      });

      if (!standalone) {
        console.log("🛡️ Reinsertando entrada de historial");
        ensureHistoryEntry();
      }
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [estado]);

  useEffect(() => {
    if (!tripSessionActiveRef.current) return;

    let startX = 0;
    let startY = 0;

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!tripSessionActiveRef.current) return;

      const touch = event.touches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;

      if (
        startX < 25 &&
        deltaX > 40 &&
        Math.abs(deltaX) > Math.abs(deltaY) * 1.5
      ) {
        const now = Date.now();

        if (now - lastBackPressedRef.current >= 2000) {
          lastBackPressedRef.current = now;

          toast.info("Presiona atrás nuevamente para salir", {
            toastId: "double-back-exit",
            autoClose: 2000,
          });
        }
      }
    };

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
    };
  }, [estado]);

  useEffect(() => {
    const savedQuery = localStorage.getItem("taxi_destination_query") || "";
    const savedAddress = localStorage.getItem("taxi_destination_address") || "";
    const savedLat = localStorage.getItem("taxi_destination_lat");
    const savedLng = localStorage.getItem("taxi_destination_lng");
    const savedUpdatedAt = localStorage.getItem("taxi_destination_updated_at");

    if (savedQuery) setDestinationQuery(savedQuery);
    if (savedAddress) setDestinationAddress(savedAddress);
    if (savedLat && savedLng) {
      const latNum = Number(savedLat);
      const lngNum = Number(savedLng);
      const updatedAtNum = Number(savedUpdatedAt || "0");
      const isFresh =
        Number.isFinite(updatedAtNum) &&
        Date.now() - updatedAtNum <= DESTINATION_STORAGE_TTL_MS;

      if (isFresh && isValidCoordinatePair(latNum, lngNum)) {
        setDestinationLat(latNum);
        setDestinationLng(lngNum);
        hasSeededDestinationRef.current = true;
      } else {
        localStorage.removeItem("taxi_destination_lat");
        localStorage.removeItem("taxi_destination_lng");
        localStorage.removeItem("taxi_destination_updated_at");
      }
    }
  }, []);

  useEffect(() => {
    if (destinationQuery)
      localStorage.setItem("taxi_destination_query", destinationQuery);
    else localStorage.removeItem("taxi_destination_query");
  }, [destinationQuery]);

  useEffect(() => {
    destinationAddressRef.current = destinationAddress;
    if (destinationAddress)
      localStorage.setItem("taxi_destination_address", destinationAddress);
    else localStorage.removeItem("taxi_destination_address");
  }, [destinationAddress]);

  useEffect(() => {
    if (destinationLat !== null && destinationLng !== null) {
      localStorage.setItem("taxi_destination_lat", String(destinationLat));
      localStorage.setItem("taxi_destination_lng", String(destinationLng));
      localStorage.setItem("taxi_destination_updated_at", String(Date.now()));
      return;
    }

    localStorage.removeItem("taxi_destination_lat");
    localStorage.removeItem("taxi_destination_lng");
    localStorage.removeItem("taxi_destination_updated_at");
  }, [destinationLat, destinationLng]);

  // GEOCONFIG ESTABLE - Solo cambia cuando el email cambia realmente
  const geoConfig = useMemo(
    () => ({
      email: userPosition?.email || "",
      name: userPosition?.name || "Pasajero",
      role: "pasajero" as const,
      // 🛑 Se envía el estado REAL del pasajero. Si faltara, el latido de GPS
      // publicaba `estado: "activo"` y el backend lo guardaba en la BD,
      // pisando `buscando`/`asignado`/`encamino`/`encurso`.
      estado: estado as EstadoUsuario,
    }),
    [userPosition?.email, userPosition?.name, estado],
  );

  // GPS con callback estable usando refs
  const handlePositionUpdate = useCallback(
    (pos: any) => {
      if (pos.lat && pos.lng) {
        const current = userPositionRef.current;
        if (current?.lat !== pos.lat || current?.lng !== pos.lng) {
          setUserPosition({
            ...current,
            lat: pos.lat,
            lng: pos.lng,
          } as any);
        }
      }
    },
    [setUserPosition],
  );

  useGeolocation(geoConfig, handlePositionUpdate);

  const destinationPosition = useMemo<[number, number] | null>(() => {
    if (destinationLat === null || destinationLng === null) return null;
    return [destinationLat, destinationLng];
  }, [destinationLat, destinationLng]);

  useEffect(() => {
    if (estado !== "pendiente") return;
    if (!userPosition?.lat || !userPosition?.lng) return;

    if (!destinationPosition) {
      setDistanciaRutaMapboxKm(null);
      setTarifaEstimada(null);
      setDistanciaEstimadaKm(null);
      return;
    }

    // Mientras Mapbox todavía no responde,
    // usamos la distancia geométrica únicamente como valor provisional.
    if (distanciaRutaMapboxKm === null) {
      const distanciaKm = getDistanceKm(
        Number(userPosition.lat),
        Number(userPosition.lng),
        destinationPosition[0],
        destinationPosition[1],
      );

      const tarifa = calcularTarifaPorDistancia(distanciaKm);

      setDistanciaEstimadaKm(distanciaKm);
      setTarifaEstimada(tarifa);
    }
  }, [
    estado,
    userPosition?.lat,
    userPosition?.lng,
    destinationPosition,
    distanciaRutaMapboxKm,
  ]);
  useEffect(() => {
    if (hasSeededDestinationRef.current) return;
    if (destinationLat !== null && destinationLng !== null) {
      hasSeededDestinationRef.current = true;
      return;
    }
    if (!userPosition?.lat || !userPosition?.lng) return;

    setDestinationLat(userPosition.lat);
    setDestinationLng(userPosition.lng);
    hasSeededDestinationRef.current = true;
  }, [userPosition?.lat, userPosition?.lng, destinationLat, destinationLng]);

  useEffect(() => {
    if (estado === "encurso") {
      setRutaDestinoPreview([]);
      previewRouteSeedRef.current = { origin: null, destination: null };
      return;
    }

    if (!userPosition?.lat || !userPosition?.lng || !destinationPosition) {
      setRutaDestinoPreview([]);
      previewRouteSeedRef.current = { origin: null, destination: null };
      return;
    }

    const currentOrigin = L.latLng(
      Number(userPosition.lat),
      Number(userPosition.lng),
    );
    const currentDestination = L.latLng(
      destinationPosition[0],
      destinationPosition[1],
    );
    const previous = previewRouteSeedRef.current;

    if (!previous.origin || !previous.destination) {
      previewRouteSeedRef.current = {
        origin: currentOrigin,
        destination: currentDestination,
      };
      setRutaDestinoPreview([]);
      return;
    }

    const originDelta = currentOrigin.distanceTo(previous.origin);
    const destinationDelta = currentDestination.distanceTo(
      previous.destination,
    );

    if (
      originDelta >= PREVIEW_ORIGIN_RECALC_METERS ||
      destinationDelta >= PREVIEW_DEST_RECALC_METERS
    ) {
      previewRouteSeedRef.current = {
        origin: currentOrigin,
        destination: currentDestination,
      };
      setRutaDestinoPreview([]);
    }
  }, [
    estado,
    userPosition?.lat,
    userPosition?.lng,
    destinationPosition?.[0],
    destinationPosition?.[1],
  ]);

  useEffect(() => {
    if (estado !== "encurso") {
      setRutaDestinoEnCurso([]);
      return;
    }

    if (!destinationPosition || !taxiPos?.lat || !taxiPos?.lng) {
      setRutaDestinoEnCurso([]);
    }
  }, [
    estado,
    destinationPosition?.[0],
    destinationPosition?.[1],
    taxiPos?.lat,
    taxiPos?.lng,
  ]);

  const limpiarDestino = useCallback(() => {
    setDestinationQuery("");
    setDestinationAddress("");
    setDestinationLat(userPosition?.lat ?? null);
    setDestinationLng(userPosition?.lng ?? null);
  }, [userPosition?.lat, userPosition?.lng]);

  const limpiarMapaDestino = useCallback(() => {
    setRutaDestinoPreview([]);
    setRutaDestinoEnCurso([]);
    setGeometriaRuta([]);
    setHistorialRuta([]);

    setDestinationAddress("");
    setDestinationQuery("");
    setDestinationLat(null);
    setDestinationLng(null);

    setDestinoConfirmado(false);
    setTarifaEstimada(null);
    setDistanciaEstimadaKm(null);

    setSelectorDestinoAbierto(false);
    setDestinoColapsado(false);

    localStorage.removeItem("taxi_destination_query");
    localStorage.removeItem("taxi_destination_address");
    localStorage.removeItem("taxi_destination_lat");
    localStorage.removeItem("taxi_destination_lng");
    localStorage.removeItem("taxi_destination_updated_at");
  }, []);

  const actualizarDestinoEnServidor = useCallback(
    (
      nextLat: number | null,
      nextLng: number | null,
      nextAddress?: string,
      nextDistanceKm?: number | null,
      nextFare?: number | null,
    ) => {
      const passengerEmail = userPosition?.email?.toLowerCase().trim();

      if (!passengerEmail || !socket.connected) return;

      const addressToSend =
        nextAddress ??
        destinationAddressRef.current ??
        destinationAddress ??
        destinationQuery ??
        "Destino no especificado";

      console.log("📤 ENVIANDO update_trip_destination:", {
        lat: nextLat,
        lng: nextLng,
        address: addressToSend,
        distanceKm: nextDistanceKm ?? distanciaRutaMapboxKm,
        fare: nextFare ?? tarifaEstimada,
      });

      socket.emit("update_trip_destination", {
        pasajeroEmail: passengerEmail,
        destinationLat: nextLat,
        destinationLng: nextLng,
        destinationAddress: addressToSend,
        estimatedDistanceKm: nextDistanceKm ?? distanciaRutaMapboxKm,
        estimatedFare: nextFare ?? tarifaEstimada,
      });
    },
    [
      destinationAddress,
      destinationQuery,
      userPosition?.email,
      distanciaRutaMapboxKm,
      tarifaEstimada,
    ],
  );

  const normalizarUbicacion = (value?: string | null) =>
    (value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();

  const esDestinoDeCiudadValles = (address: any) => {
    if (!address) return false;

    const estado = normalizarUbicacion(address.state);

    const localidades = [address.city, address.town, address.municipality].map(
      normalizarUbicacion,
    );

    return (
      estado === "san luis potosi" && localidades.includes("ciudad valles")
    );
  };

  const geocodificarDestino = useCallback(
    async (query: string) => {
      const cleanQuery = query.trim();
      if (!cleanQuery) {
        toast.error("Escribe un destino primero.");
        return;
      }

      setIsSearchingDestination(true);
      try {
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("q", cleanQuery);
        url.searchParams.set("limit", "1");
        url.searchParams.set("addressdetails", "1");
        url.searchParams.set("countrycodes", "mx");

        const response = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("No se pudo buscar la dirección");

        const results = await response.json();
        if (!Array.isArray(results) || results.length === 0) {
          toast.error("No encontré esa ubicación. Prueba con otra dirección.");
          return;
        }

        const match = results[0];
        const latNum = Number(match.lat);
        const lngNum = Number(match.lon);

        if (!esDestinoDeCiudadValles(match.address)) {
          toast.error(
            "Por el momento solo damos servicio en Ciudad Valles, S.L.P.",
          );
          return;
        }

        if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
          toast.error("La ubicación encontrada no es válida.");
          return;
        }

        setDestinationLat(latNum);
        setDestinationLng(lngNum);

        const nextAddress = limpiarDireccionDestino(
          match.display_name || cleanQuery,
        );
        destinationAddressRef.current = nextAddress;
        setDestinationAddress(nextAddress);
        setDestinationQuery(nextAddress);
        setRutaDestinoPreview([]);
        setRutaDestinoEnCurso([]);
        if (
          estado === "encurso" ||
          estado === "encamino" ||
          estado === "asignado"
        ) {
          // La actualización al servidor se hace después de calcular la nueva ruta Mapbox.
        }
        toast.success("Destino ubicado en el mapa.");
      } catch (error) {
        console.warn("Error buscando destino:", error);
        toast.error("No pude buscar el destino en este momento.");
      } finally {
        setIsSearchingDestination(false);
      }
    },
    [estado, actualizarDestinoEnServidor],
  );

  const actualizarDestinoDesdeMarker = useCallback(
    async (lat: number, lng: number) => {
      if (!isValidCoordinatePair(lat, lng)) {
        toast.error("La posición seleccionada no es válida.");
        return;
      }

      /**
       * 🛡️ El pin del destino es arrastrable DURANTE el viaje, y un roce
       * accidental en el mapa genera `dragend` igual que un arrastre
       * deliberado. En la prueba del 4-nov se cambiaron el destino y la tarifa
       * 9 veces en 80 s (de 4.8 a 14.8 km) sin que el usuario lo pretendiera:
       * cada cambio descarta la ruta y reescribe el viaje en el servidor.
       * Se exige un desplazamiento mínimo real y se limita la frecuencia.
       */
      const destinoLatActual = destinationLatRef.current;
      const destinoLngActual = destinationLngRef.current;

      if (destinoLatActual !== null && destinoLngActual !== null) {
        const desplazamiento = L.latLng(
          Number(destinoLatActual),
          Number(destinoLngActual),
        ).distanceTo(L.latLng(lat, lng));

        if (desplazamiento < DESTINATION_MIN_MOVE_METERS) {
          return;
        }
      }

      const ahora = Date.now();

      if (ahora - lastDestinationChangeAtRef.current < DESTINATION_CHANGE_MIN_INTERVAL_MS) {
        return;
      }

      lastDestinationChangeAtRef.current = ahora;

      try {
        const url = new URL("https://nominatim.openstreetmap.org/reverse");
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("lat", String(lat));
        url.searchParams.set("lon", String(lng));
        url.searchParams.set("zoom", "18");
        url.searchParams.set("addressdetails", "1");

        const response = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
        });

        if (!response.ok) throw new Error("No se pudo resolver la dirección");

        const data = await response.json();
        if (!esDestinoDeCiudadValles(data.address)) {
          toast.error(
            "Por el momento solo damos servicio en Ciudad Valles, S.L.P.",
          );
          return;
        }

        setDestinationLat(lat);
        setDestinationLng(lng);
        setRutaDestinoPreview([]);
        setRutaDestinoEnCurso([]);

        const label = limpiarDireccionDestino(
          data.display_name || `Ubicación ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        );
        destinationAddressRef.current = label;
        setDestinationAddress(label);
        setDestinationQuery(label);

        if (
          estado === "encurso" ||
          estado === "encamino" ||
          estado === "asignado"
        ) {
          // La actualización al servidor se hace después de calcular la nueva ruta Mapbox.
        }
      } catch (error) {
        console.warn("Error resolviendo destino:", error);

        toast.error(
          "No pude verificar que el destino esté dentro de Ciudad Valles.",
        );
      }
    },
    [estado, actualizarDestinoEnServidor],
  );

  const clampBubbleX = useCallback((x: number) => {
    if (typeof window === "undefined") return x;
    const maxX = window.innerWidth - CHAT_BUBBLE_SIZE - CHAT_BUBBLE_MARGIN;
    return Math.min(Math.max(x, CHAT_BUBBLE_MARGIN), maxX);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (chatBubbleX !== null) return;
    const initialX = window.innerWidth - CHAT_BUBBLE_SIZE - CHAT_BUBBLE_MARGIN;
    setChatBubbleX(initialX);
  }, [chatBubbleX]);

  useEffect(() => {
    const handleResize = () => {
      if (chatBubbleX === null) return;
      setChatBubbleX((current) =>
        current === null ? current : clampBubbleX(current),
      );
    };

    const handleSessionReplaced = () => {
      setSearchFlowActivo(false);
      setTaxistaAsignado(null);
      setTaxiPos(null);
      setEstado(TRIP_STATES.PENDIENTE);
      setHistorialRuta([]);
      setGeometriaRuta([]);
      setRutaDestinoPreview([]);
      setRutaDestinoEnCurso([]);
      setChatAbierto(false);
      toast.warn(
        "Se abrió otra sesión para esta cuenta. Se limpió el estado local.",
        { autoClose: 3500 },
      );
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener(
      "socket-session-replaced",
      handleSessionReplaced as EventListener,
    );
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener(
        "socket-session-replaced",
        handleSessionReplaced as EventListener,
      );
    };
  }, [chatBubbleX, clampBubbleX]);

  const handleChatBubblePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const baseX = chatBubbleX ?? CHAT_BUBBLE_MARGIN;
    chatDragRef.current = {
      startPointerX: event.clientX,
      startBubbleX: baseX,
      moved: false,
    };

    setIsDraggingChatBubble(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleChatBubblePointerMove = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (!isDraggingChatBubble) return;

    const deltaX = event.clientX - chatDragRef.current.startPointerX;
    if (Math.abs(deltaX) > 3) {
      chatDragRef.current.moved = true;
    }

    const nextX = clampBubbleX(chatDragRef.current.startBubbleX + deltaX);
    setChatBubbleX(nextX);
  };

  const finishChatBubbleDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (!isDraggingChatBubble) return;

    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDraggingChatBubble(false);

    if (typeof window === "undefined") return;

    const currentX = chatBubbleX ?? CHAT_BUBBLE_MARGIN;
    const snapLeft = CHAT_BUBBLE_MARGIN;
    const snapRight = window.innerWidth - CHAT_BUBBLE_SIZE - CHAT_BUBBLE_MARGIN;
    const middle = window.innerWidth / 2;
    const nextSnap =
      currentX + CHAT_BUBBLE_SIZE / 2 < middle ? snapLeft : snapRight;

    setChatBubbleX(nextSnap);

    if (!chatDragRef.current.moved) {
      setChatAbierto(true);
    }
  };

  const chatPanelOnLeft =
    typeof window !== "undefined" && chatBubbleX !== null
      ? chatBubbleX + CHAT_BUBBLE_SIZE / 2 < window.innerWidth / 2
      : false;

  // ============================================================
  // LISTENERS DE SOCKET - SIN DEPENDENCIAS VOLÁTILES
  // ============================================================
  useEffect(() => {
    if (!socket) return;

    const handleTripDestinationUpdated = (data: any) => {
      console.log("🚩 PASAJERO RECIBIÓ trip_destination_updated:", data);
      const passengerEmail = userPositionRef.current?.email
        ?.toLowerCase()
        .trim();
      const incomingEmail = String(data?.pasajeroEmail || "")
        .toLowerCase()
        .trim();
      if (incomingEmail && passengerEmail && incomingEmail !== passengerEmail)
        return;

      // 🗺️ Comparar el destino recibido con el último destino conocido.
      const previousLat = destinationLatRef.current;
      const previousLng = destinationLngRef.current;

      const nextLat =
        data?.destinationLat !== undefined && data?.destinationLat !== null
          ? Number(data.destinationLat)
          : previousLat;

      const nextLng =
        data?.destinationLng !== undefined && data?.destinationLng !== null
          ? Number(data.destinationLng)
          : previousLng;

      const validCoordinates =
        nextLat !== null &&
        nextLng !== null &&
        Number.isFinite(nextLat) &&
        Number.isFinite(nextLng);

      const destinationChanged =
        validCoordinates &&
        (previousLat === null ||
          previousLng === null ||
          Math.abs(previousLat - nextLat) > 0.000001 ||
          Math.abs(previousLng - nextLng) > 0.000001);

      if (validCoordinates) {
        // Actualizar referencias antes de solicitar el nuevo render.
        destinationLatRef.current = nextLat;
        destinationLngRef.current = nextLng;

        setDestinationLat(nextLat);
        setDestinationLng(nextLng);
      }

      // 🔄 Igual que el taxista: recalcular solo ante un cambio real.
      if (destinationChanged && estadoRef.current === "encurso") {
        console.log("🗺️ PASAJERO: destino cambiado; recalculando ruta", {
          anteriorLat: previousLat,
          anteriorLng: previousLng,
          nuevoLat: nextLat,
          nuevoLng: nextLng,
        });

        setRutaDestinoEnCurso([]);
        setRouteRefreshToken((prev) => prev + 1);
      }
      if (data?.destinationAddress) {
        const direccionLimpia = limpiarDireccionDestino(
          String(data.destinationAddress),
        );
        destinationAddressRef.current = direccionLimpia;
        setDestinationAddress(direccionLimpia);
        setDestinationQuery(direccionLimpia);
      }

      if (typeof data?.estimatedFare === "number") {
        setTarifaEstimada(data.estimatedFare);
      }

      if (typeof data?.estimatedDistanceKm === "number") {
        setDistanciaEstimadaKm(data.estimatedDistanceKm);
        setDistanciaRutaMapboxKm(data.estimatedDistanceKm);
      }
    };

    // ACEPTACIÓN DEL TAXI (sin setTimeout innecesario)
    socket.on("response_from_taxi", (data) => {
      console.log("Respuesta del taxi recibida:", data);

      if (data.accepted) {
        setSearchFlowActivo(false);
        const cleanEmail = data.tEmail?.toLowerCase().trim();
        const infoTaxista: Payload = {
          email: cleanEmail,
          name: data.name || "Taxista",
          taxiNumber: data.taxiNumber || "S/N",
          role: "taxista",
          lat: data.lat || 0,
          lng: data.lng || 0,
          estado: "asignado",
          timestamp: new Date().toISOString(),
        } as Payload;

        setTaxistaAsignado(infoTaxista);
        setEstado(TRIP_STATES.ASIGNADO);

        // 🚕 Posición inicial del taxi: `taxiData` es el mismo documento del
        // taxista, así que sirve de respaldo cuando `lat/lng` no vienen sueltos.
        const initialLat = Number(data.lat ?? data.taxiData?.lat);
        const initialLng = Number(data.lng ?? data.taxiData?.lng);

        if (
          Number.isFinite(initialLat) &&
          Number.isFinite(initialLng) &&
          initialLat !== 0 &&
          initialLng !== 0
        ) {
          // Desde aquí manda el canal en vivo; reiniciamos el sello para que
          // `taxi_moved` no gane esta primera posición.
          lastLiveTaxiFixAtRef.current = Date.now();
          setTaxiPos({ lat: initialLat, lng: initialLng, heading: 0 });
        } else {
          setTaxiPos(null);
        }

        /**
         * 🧹 Limpieza de residuos del viaje anterior. `geometriaRuta` NO se
         * borraba aquí: si quedaba una ruta vieja, el gate
         * `geometriaRuta.length === 0` impedía calcular la nueva ruta de
         * aproximación y se seguía dibujando la polilínea antigua (una línea que
         * no corresponde al taxi actual).
         */
        setHistorialRuta([]);
        setGeometriaRuta([]);
        setRutaDestinoEnCurso([]);
        setRutaDestinoPreview([]);
        previewRouteSeedRef.current = { origin: null, destination: null };
        lastDestinoRecalcAtRef.current = 0;
        setRouteRefreshToken((prev) => prev + 1);

        if (typeof data.estimatedFare === "number") {
          setTarifaEstimada(data.estimatedFare);
        }
        if (typeof data.estimatedDistanceKm === "number") {
          setDistanciaEstimadaKm(data.estimatedDistanceKm);
        }

        toast.success(
          `¡La Unidad ${data.taxiNumber} (${data.name}) va en camino!`,
          {
            position: "top-center",
            autoClose: 5000,
          },
        );
      }
    });

    // TAXI MOVIDO (con orientación geográfica)
    socket.on("taxi_moved", (data: any) => {
      const emailAsignado = taxistaAsignadoRef.current?.email
        ?.toLowerCase()
        .trim();
      const emailEntrante = (data.tEmail || data.email || data.taxistaEmail)
        ?.toLowerCase()
        .trim();

      if (emailAsignado && emailEntrante === emailAsignado) {
        /**
         * ⚠️ `taxi_moved` no trae la posición del taxista: el backend relee la
         * coordenada guardada en la BD (locationHandler.ts). Si el respaldo HTTP
         * de GPS se retrasa o falla, aquí llega una y otra vez la misma
         * coordenada vieja. Mientras el canal en vivo (`update_trip_path`) esté
         * entregando datos recientes, este evento se ignora.
         */
        if (Date.now() - lastLiveTaxiFixAtRef.current < LIVE_FIX_PREFERENCE_MS) {
          if (Date.now() - lastPosLogAtRef.current > 5000) {
            lastPosLogAtRef.current = Date.now();
            console.log("🛰️ PASAJERO pos taxi: taxi_moved IGNORADO (canal en vivo reciente)", {
              lat: data.lat,
              lng: data.lng,
            });
          }
          return;
        }

        const latNum = Number(data.lat);
        const lngNum = Number(data.lng);

        if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return;

        if (Date.now() - lastPosLogAtRef.current > 5000) {
          lastPosLogAtRef.current = Date.now();
          console.log("🛰️ PASAJERO pos taxi ← taxi_moved (BD)", {
            lat: latNum,
            lng: lngNum,
          });
        }

        const posAnterior = taxiPosRef.current;
        const pasajeroPos = userPositionRef.current;

        const nuevoHeading = calcularHeading(
          posAnterior ? { lat: posAnterior.lat, lng: posAnterior.lng } : null,
          { lat: latNum, lng: lngNum },
          pasajeroPos
            ? { lat: Number(pasajeroPos.lat), lng: Number(pasajeroPos.lng) }
            : null,
          estadoRef.current,
          posAnterior?.heading || 0,
        );

        setTaxiPos({ lat: latNum, lng: lngNum, heading: nuevoHeading || 0 });
      }
    });

    // CANAL EN VIVO DE POSICIÓN (aproximación y viaje en curso)
    socket.on("update_trip_path", (data: { lat: number; lng: number }) => {
      const latNum = Number(data.lat);
      const lngNum = Number(data.lng);

      if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return;

      // El backend relaya estas coordenadas tal cual las emite el taxista.
      lastLiveTaxiFixAtRef.current = Date.now();

      if (Date.now() - lastPosLogAtRef.current > 5000) {
        lastPosLogAtRef.current = Date.now();
        console.log("🛰️ PASAJERO pos taxi ← update_trip_path (directo)", {
          lat: latNum,
          lng: lngNum,
          estado: estadoRef.current,
        });
      }

      const posAnterior = taxiPosRef.current;
      const pasajeroPos = userPositionRef.current;
      const destinoLat = destinationLatRef.current;
      const destinoLng = destinationLngRef.current;
      const destino =
        destinoLat !== null && destinoLng !== null
          ? { lat: Number(destinoLat), lng: Number(destinoLng) }
          : null;

      const nuevoHeading = calcularHeading(
        posAnterior ? { lat: posAnterior.lat, lng: posAnterior.lng } : null,
        { lat: latNum, lng: lngNum },
        // En viaje en curso el rumbo se mide hacia el destino, no hacia el
        // propio taxi (antes se pasaba su posición anterior como objetivo).
        destino ?? (pasajeroPos
          ? { lat: Number(pasajeroPos.lat), lng: Number(pasajeroPos.lng) }
          : null),
        estadoRef.current,
        posAnterior?.heading || 0,
      );

      setTaxiPos({ lat: latNum, lng: lngNum, heading: nuevoHeading || 0 });

      // La trayectoria GPS sólo se acumula durante el viaje en curso; en la
      // aproximación el tramo lo dibuja `geometriaRuta`.
      if (estadoRef.current === "encurso") {
        setHistorialRuta((prev) => {
          const newHistory = [...prev, L.latLng(latNum, lngNum)];
          return newHistory.length > 500 ? newHistory.slice(-500) : newHistory;
        });
      }
    });

    // ACTUALIZACIÓN DE ESTADO DEL VIAJE
    socket.on("trip_destination_updated", handleTripDestinationUpdated);

    socket.on(
      "trip_status_update",
      (data: { estado: string; pasajeroEmail?: string; taxiData?: any }) => {
        const miEmail = userPositionRef.current?.email?.toLowerCase().trim();
        const emailRecibido = data.pasajeroEmail?.toLowerCase().trim();
        const nextEstado = String(data.estado || "")
          .toLowerCase()
          .trim();

        if (!shouldAcceptStateTransition(estadoRef.current, nextEstado)) {
          console.warn("🛡️ Estado ignorado por guard de sincronización:", {
            current: estadoRef.current,
            next: nextEstado,
          });
          return;
        }

        if (
          data.estado === "encurso" &&
          (!emailRecibido || emailRecibido === miEmail)
        ) {
          /**
           * Idempotencia: el backend puede reenviar el mismo estado (latido de
           * `reproducir_estado_viaje`, `passenger_on_board` repetido). Si ya
           * estamos en curso NO se reinicia la trayectoria GPS ni se descarta la
           * ruta ya calculada.
           */
          if (estadoRef.current === TRIP_STATES.ENCURSO) return;

          setSearchFlowActivo(false);

          /**
           * 🎯 Ancla del viaje en curso.
           * Se prefiere la última coordenada del canal en vivo (`taxiPosRef`)
           * y sólo si no existe se usa la del payload (`taxiData`, leída de la
           * BD y por tanto susceptible de venir atrasada). Antes se usaba
           * siempre la última posición conocida, aunque fuera la del momento
           * en que el taxista aceptó el viaje.
           */
          const taxiActual = taxiPosRef.current;
          const dataTaxi = data.taxiData;
          const anchorLat = Number(taxiActual?.lat ?? dataTaxi?.lat);
          const anchorLng = Number(taxiActual?.lng ?? dataTaxi?.lng);
          const hasAnchor =
            Number.isFinite(anchorLat) &&
            Number.isFinite(anchorLng) &&
            anchorLat !== 0 &&
            anchorLng !== 0;

          // La ruta al destino debe construirse desde la posición ACTUAL: se
          // descarta cualquiera calculada con una coordenada vieja y se fuerza
          // una nueva consulta al enrutador.
          setRutaDestinoEnCurso([]);
          setRutaDestinoPreview([]);
          previewRouteSeedRef.current = { origin: null, destination: null };
          lastDestinoRecalcAtRef.current = 0;

          if (hasAnchor) {
            setTaxiPos({
              lat: anchorLat,
              lng: anchorLng,
              heading: Number(taxiActual?.heading) || 0,
            });
            setHistorialRuta([[anchorLat, anchorLng]]);
          } else {
            setHistorialRuta([]);
          }

          // La ruta de aproximación ya no aplica: se vacía (no un punto suelto)
          // para que el gate `geometriaRuta.length === 0` siga siendo válido.
          setGeometriaRuta([]);

          setRouteRefreshToken((prev) => prev + 1);
          setEstado(TRIP_STATES.ENCURSO);
          setChatAbierto(false);

          showToastOnce(
            "pasajero:trip-started",
            () => {
              toast.success("¡Viaje iniciado! Que tengas un buen trayecto.");
            },
            { cooldownMs: 4000 },
          );
        }

        if (nextEstado === "finalizado") {
          if (
            !["asignado", "encamino", "encurso"].includes(estadoRef.current)
          ) {
            return;
          }
          setSearchFlowActivo(false);
          setEstado(TRIP_STATES.FINALIZADO);
          setTaxistaAsignado(null);
          setTaxiPos(null);
          setChatAbierto(false);
          limpiarMapaDestino();
          showToastOnce(
            "pasajero:trip-finished",
            () => {
              toast.success("¡Viaje finalizado!");
            },
            { cooldownMs: 4000 },
          );
        }

        // Escudo contra saltos accidentales
        if (
          ["encurso", "finalizado"].includes(estadoRef.current) &&
          nextEstado === "buscando"
        ) {
          console.warn(
            "Ignorado salto a 'buscando' porque el viaje ya está cerrado o en curso.",
          );
          return;
        }

        if (nextEstado === "buscando") {
          setSearchFlowActivo(true);
          setTaxistaAsignado(null);
          setTaxiPos(null);
          setEstado(TRIP_STATES.BUSCANDO);
          return;
        }

        if (nextEstado === "preasignado") {
          setSearchFlowActivo(true);
          setEstado(TRIP_STATES.PREASIGNADO);
          return;
        }

        if (["asignado", "encamino"].includes(nextEstado)) {
          setSearchFlowActivo(false);
          setEstado(nextEstado as ViajeEstado);
          return;
        }
      },
    );

    // VIAJE TERMINADO
    socket.on("trip_finished", (data: { pasajeroEmail: string }) => {
      const miEmail = userPositionRef.current?.email?.toLowerCase().trim();
      const emailRecibido = data.pasajeroEmail?.toLowerCase().trim();

      if (!["asignado", "encamino", "encurso"].includes(estadoRef.current)) {
        return;
      }

      if (emailRecibido === miEmail || !data.pasajeroEmail) {
        setSearchFlowActivo(false);

        // El viaje terminó realmente en el servidor.
        // Conservamos "finalizado" para mostrar la pantalla de cierre.
        setEstado(TRIP_STATES.FINALIZADO);

        setTaxistaAsignado(null);
        setTaxiPos(null);
        setTarifaEstimada(null);
        setDistanciaEstimadaKm(null);
        setChatAbierto(false);
        limpiarMapaDestino();
        showToastOnce(
          "pasajero:trip-finished-extended",
          () => {
            toast.success(
              "¡Viaje finalizado! Gracias por viajar con nosotros.",
              {
                position: "top-center",
                autoClose: 4000,
              },
            );
          },
          { cooldownMs: 4000 },
        );
      }
    });

    // TAXI RECHAZÓ LA SOLICITUD
    socket.on("taxi_rejected_request", () => {
      if (!["asignado", "encamino", "encurso"].includes(estadoRef.current)) {
        console.warn(
          "🛡️ taxi_rejected_request ignorado: la solicitud ya no está activa o el viaje terminó.",
        );
        return;
      }
      setSearchFlowActivo(true);
      setTaxistaAsignado(null);
      setTaxiPos(null);
      setEstado(TRIP_STATES.BUSCANDO);
      toast.info("Buscando otra unidad cercana...");
    });

    socket.on("no_taxis_available", (payload?: { message?: string }) => {
      // El servidor terminó todos los intentos y no encontró una unidad.
      // Si seguimos buscando, ya no hay una solicitud activa que mantener.
      if (["encurso", "finalizado"].includes(estadoRef.current)) {
        console.warn(
          "🛡️ no_taxis_available ignorado: el viaje ya está cerrado.",
          {
            estado: estadoRef.current,
          },
        );
        return;
      }

      setSearchFlowActivo(false);
      setTaxistaAsignado(null);
      setTaxiPos(null);
      setEstado(TRIP_STATES.PENDIENTE);

      showToastOnce(
        "pasajero:no-taxis-available",
        () => {
          toast.info(
            payload?.message || "No hay taxistas disponibles en este momento.",
            { autoClose: 3000 },
          );
        },
        { cooldownMs: 3000 },
      );
    });

    socket.on("dispatch_error", (payload?: { message?: string }) => {
      if (!["asignado", "encamino", "encurso"].includes(estadoRef.current)) {
        console.warn(
          "🛡️ dispatch_error ignorado: la solicitud ya no está activa.",
        );
        return;
      }
      setSearchFlowActivo(true);
      setEstado(TRIP_STATES.BUSCANDO);
      if (payload?.message) {
        showToastOnce(
          `pasajero:${payload.message || "dispatch-warning"}`,
          () => {
            toast.warn(payload.message, { autoClose: 2500 });
          },
          { cooldownMs: 3000 },
        );
      }
    });

    return () => {
      socket.off("taxi_moved");
      socket.off("update_trip_path");
      socket.off("response_from_taxi");
      socket.off("trip_destination_updated");
      socket.off("trip_status_update");
      socket.off("trip_finished");
      socket.off("taxi_rejected_request");
      socket.off("no_taxis_available");
      socket.off("dispatch_error");
    };
  }, [socket]); //  SOLO depende de socket - nunca se re-registra por cambios de posición

  // ============================================================
  //  REHIDRATACIÓN DE VIAJE ACTIVO AL RECONECTAR / VOLVER DE SEGUNDO PLANO
  // ============================================================
  useEffect(() => {
    if (!socket) return;

    const miEmail =
      userPosition?.email?.toLowerCase().trim() ||
      localStorage.getItem("email")?.toLowerCase().trim();
    if (!miEmail) return;

    const requestRehydrate = () => {
      if (!socket.connected) return;
      socket.emit("request_rehydrate", { email: miEmail, role: "pasajero" });
      setIsRehydrating(true);
    };

    const handleRehydrateSuccess = (data: any) => {
      console.log("🚨 ENTRA REHYDRATE_TRIP_RESULT", {
        estadoActual: estadoRef.current,
        data,
      });

      if (!data?.success || !data?.pasajero) {
        setIsRehydrating(false);
        return;
      }

      const nextEstado = String(data.estado || "")
        .toLowerCase()
        .trim();

      const teniaViajeActivoLocalmente =
        tripSessionActiveRef.current ||
        ["asignado", "encamino", "encurso"].includes(estadoRef.current) ||
        !!taxistaAsignadoRef.current?.requestId;

      console.log("🔄 PASAJERO REHYDRATE_RESULT", {
        estadoActual: estadoRef.current,
        nextEstado,
        hasActiveTrip: data.hasActiveTrip,
        requestId: data.requestId,
        counterpart: data.counterpart,
        taxistaAsignado: data.taxistaAsignado,
        estimatedFare: data.estimatedFare,
        estimatedDistanceKm: data.estimatedDistanceKm,
      });

      const isInactiveTrip = [
        "activo",
        "pendiente",
        "cancelado",
        "finalizado",
      ].includes(nextEstado);

      const isBuscando = nextEstado === "buscando";
      const isPreasignado = nextEstado === "preasignado";
      const taxistaRehidratado = data.counterpart ?? null;

      const resolvedRequestId =
        taxistaRehidratado?.requestId ||
        data?.requestId ||
        taxistaAsignadoRef.current?.requestId;

      if (isInactiveTrip) {
        if (teniaViajeActivoLocalmente) {
          console.warn(
            "🛡️ REHYDRATE PASAJERO SIN VIAJE PERO HAY VIAJE LOCAL ACTIVO → NO SE LIMPIA",
            {
              estado: estadoRef.current,
              requestId: resolvedRequestId,
              taxista: taxistaAsignadoRef.current?.email,
              tripSessionActive: tripSessionActiveRef.current,
            },
          );

          setIsRehydrating(false);
          return;
        }

        setIsRehydrating(false);
        return;
      }

      if (!isBuscando && !isPreasignado && !taxistaRehidratado) {
        if (teniaViajeActivoLocalmente) {
          console.warn(
            "🛡️ REHYDRATE PASAJERO SIN VIAJE PERO HAY VIAJE LOCAL ACTIVO → NO SE LIMPIA",
            {
              estado: estadoRef.current,
              requestId: resolvedRequestId,
              taxista: taxistaAsignadoRef.current?.email,
              tripSessionActive: tripSessionActiveRef.current,
            },
          );

          setIsRehydrating(false);
          return;
        }

        setIsRehydrating(false);
        return;
      }

      setEstado(nextEstado as ViajeEstado);

      if (isBuscando || isPreasignado) {
        tripSessionActiveRef.current = true;
        setIsRehydrating(false);
        return;
      }

      setTaxistaAsignado(taxistaRehidratado);

      tripSessionActiveRef.current = true;

      setTarifaEstimada(data.estimatedFare ?? null);
      setDistanciaEstimadaKm(data.estimatedDistanceKm ?? null);

      /**
       * Al volver del segundo plano / reconectar, la rehidratación trae la
       * posición del taxista leída de la BD. Si el canal en vivo sigue
       * entregando datos recientes, esa coordenada no debe pisar la actual
       * (provocaría un salto atrás y, en `encurso`, una ruta reconstruida
       * desde un punto viejo).
       */
      const canalVivoReciente =
        Date.now() - lastLiveTaxiFixAtRef.current < LIVE_FIX_PREFERENCE_MS;

      if (
        taxistaRehidratado?.lat &&
        taxistaRehidratado?.lng &&
        !canalVivoReciente
      ) {
        setTaxiPos({
          lat: Number(taxistaRehidratado.lat),
          lng: Number(taxistaRehidratado.lng),
          heading: 0,
        });
      }

      if (["asignado", "encamino", "encurso"].includes(nextEstado)) {
        if (nextEstado === "encurso") {
          // Eliminar la ruta vial anterior para permitir reconstruirla.
          setRutaDestinoEnCurso([]);
          lastDestinoRecalcAtRef.current = 0;
        }

        // Forzar el montaje de RoutingMachine con las coordenadas actuales.
        setRouteRefreshToken((prev) => prev + 1);
      }

      setIsRehydrating(false);
    };
    socket.on("rehydrate_trip_result", handleRehydrateSuccess);

    const onResume = () => {
      if (document.visibilityState === "visible") {
        requestRehydrate();
      }
    };

    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);

    socket.on("connect", requestRehydrate);
    requestRehydrate();

    return () => {
      socket.off("connect", requestRehydrate);
      socket.off("rehydrate_trip_result", handleRehydrateSuccess);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, [socket, userPosition?.email]);

  // ============================================================
  //  HEARTBEAT OPTIMIZADO - No se re-crea en cada cambio de posición
  // ============================================================
  useEffect(() => {
    if (!userPosition?.email || !userPosition?.lat) return;

    const interval = setInterval(() => {
      // Candado: no enviar si está inactivo
      if (
        estadoRef.current === "pendiente" ||
        estadoRef.current === "finalizado"
      )
        return;

      // Verificar que el socket esté conectado antes de emitir
      if (!socket?.connected) {
        console.warn("Socket desconectado, omitiendo heartbeat");
        return;
      }

      const pos = userPositionRef.current;
      if (pos?.lat && pos?.lng) {
        socket.emit("position", {
          ...pos,
          role: "pasajero",
          estado: estadoRef.current.toLowerCase(),
        });
      }
    }, 12000);

    return () => clearInterval(interval);
  }, [userPosition?.email, userPosition?.lat]); // Solo depende del email y si hay lat

  // ============================================================
  // SOLICITAR TAXI - CON FEEDBACK INMEDIATO
  // ============================================================
  const solicitarTaxi = useCallback(() => {
    // Escudo anti-disparos
    if (["asignado", "encamino", "encurso", "buscando"].includes(estado)) {
      console.warn("Intento de solicitarTaxi bloqueado: viaje ya activo.");
      return;
    }

    if (!userPosition?.lat || !userPosition?.lng) {
      toast.error("Esperando señal GPS...");
      return;
    }

    // Verificar conexión del socket
    if (!socket?.connected) {
      toast.error("Sin conexión al servidor. Reintentando...");
      socket?.connect?.();
      return;
    }

    // FEEDBACK INMEDIATO: Cambiar estado ANTES de emitir
    setSearchFlowActivo(true);
    setEstado(TRIP_STATES.BUSCANDO);

    socket.emit("request_taxi", {
      email: userPosition.email.toLowerCase().trim(),
      name: userPosition.name,
      lat: userPosition.lat,
      lng: userPosition.lng,
      destinationLat,
      destinationLng,
      destinationAddress: destinationAddress || destinationQuery || undefined,
      estimatedDistanceKm: distanciaRutaMapboxKm,
      estimatedFare: tarifaEstimada,
      role: "pasajero",
      estado: "buscando",
      timestamp: new Date().toISOString(),
    });

    toast.info("Buscando taxi disponible...", { autoClose: 3000 });
  }, [
    userPosition,
    estado,
    destinationLat,
    destinationLng,
    destinationAddress,
    destinationQuery,
    distanciaRutaMapboxKm,
    tarifaEstimada,
  ]);

  const cancelarSolicitud = useCallback(() => {
    setSearchFlowActivo(false);
    setEstado(TRIP_STATES.PENDIENTE);

    if (socket?.connected) {
      socket.emit("passenger_cancel", {
        pasajeroEmail: userPosition?.email?.toLowerCase().trim(),
        taxistaEmail: taxistaAsignado?.email?.toLowerCase().trim() || null,
      });
    }

    setTaxistaAsignado(null);
    setTaxiPos(null);
    setTarifaEstimada(null);
    setDistanciaEstimadaKm(null);
    setHistorialRuta([]);
    setGeometriaRuta([]);
    setRutaDestinoEnCurso([]);
    toast.info("Solicitud cancelada correctamente.");
  }, [userPosition?.email, taxistaAsignado?.email]);

  const resetearApp = useCallback(() => {
    setSearchFlowActivo(false);
    setEstado(TRIP_STATES.PENDIENTE);
    setTaxistaAsignado(null);
    setTaxiPos(null);
    setChatAbierto(false);
    setSelectorDestinoAbierto(false);
    setDestinoColapsado(false);
    limpiarMapaDestino();
  }, [limpiarMapaDestino]);

  // ============================================================
  // RECORTE DE RUTA DINÁMICA (Lógica probada de TaxistaView)
  // ============================================================
  useEffect(() => {
    // Solo actuar si tenemos posición del taxi y una ruta dibujada
    if (!taxiPos?.lat || !taxiPos?.lng || geometriaRuta.length === 0) return;
    if (!["asignado", "encamino"].includes(estado)) return;

    const posTaxi = L.latLng(Number(taxiPos.lat), Number(taxiPos.lng));
    let indiceMasCercano = -1;
    let distanciaMinima = Infinity;

    // Buscar el punto de la ruta más cercano a la posición actual del taxi
    geometriaRuta.forEach((punto: any, index: number) => {
      const pLeaflet = L.latLng(punto.lat ?? punto[0], punto.lng ?? punto[1]);
      const d = posTaxi.distanceTo(pLeaflet);
      if (d < distanciaMinima) {
        distanciaMinima = d;
        indiceMasCercano = index;
      }
    });

    // CASO A: El taxi está siguiendo la ruta. Recortamos el pasado (rendimiento alto).
    if (distanciaMinima < 45 && indiceMasCercano > 0) {
      if (geometriaRuta.length - indiceMasCercano >= 2) {
        setGeometriaRuta((prev) => prev.slice(indiceMasCercano));
      } else {
        setGeometriaRuta([]);
      }
    }
    // CASO B: El taxi se desvió (ej. cambio de calle, giro). Forzamos recálculo total.
    else if (distanciaMinima >= ROUTE_RECALC_THRESHOLD_METERS) {
      console.log(
        "🔄 Taxi se desvió de la ruta calculada, solicitando nueva ruta...",
      );
      setGeometriaRuta([]); // Al vaciarse, el RoutingMachine de abajo se vuelve a montar
      setRouteRefreshToken((prev) => prev + 1);
    }
  }, [taxiPos, estado, geometriaRuta.length]); // 👈 OJO: Dependemos del .length, no del array completo

  // ============================================================
  // RECORTE / RECÁLCULO DE LA RUTA AL DESTINO (viaje en curso)
  // ============================================================
  // `rutaDestinoEnCurso` se calculaba UNA sola vez y quedaba congelada: al
  // avanzar el taxi nadie la recortaba ni la volvía a pedir. Aquí se aplica la
  // misma lógica ya probada en TaxistaView (CASO 2: viaje en curso):
  //   · recortar el tramo ya recorrido,
  //   · reconstruir la ruta desde la posición actual cuando el taxi se aleja
  //     demasiado de la ruta dibujada.
  useEffect(() => {
    if (estado !== "encurso") return;
    if (!taxiPos?.lat || !taxiPos?.lng) return;
    if (rutaDestinoEnCurso.length <= 2) return;

    const posTaxi = L.latLng(Number(taxiPos.lat), Number(taxiPos.lng));
    let indiceMasCercano = -1;
    let distanciaMinima = Infinity;

    rutaDestinoEnCurso.forEach((punto: any, index: number) => {
      const pLeaflet = L.latLng(punto.lat ?? punto[0], punto.lng ?? punto[1]);
      const d = posTaxi.distanceTo(pLeaflet);
      if (d < distanciaMinima) {
        distanciaMinima = d;
        indiceMasCercano = index;
      }
    });

    // CASO A: el taxi va sobre la ruta → se descarta el tramo ya recorrido.
    if (distanciaMinima < 45 && indiceMasCercano > 0) {
      if (rutaDestinoEnCurso.length - indiceMasCercano >= 2) {
        setRutaDestinoEnCurso((prev) => prev.slice(indiceMasCercano));
      } else {
        // Queda demasiado poco recorrido: se vacía para que el RoutingMachine
        // vuelva a montarse y pida la ruta desde la posición actual.
        setRutaDestinoEnCurso([]);
      }
      return;
    }

    // CASO B: el taxi se salió de la ruta → reconstruir desde cero.
    // El sello temporal evita una tormenta de peticiones a Mapbox si el
    // enrutador "ajusta" el origen lejos de la posición real del vehículo.
    const ahora = Date.now();

    if (
      distanciaMinima >= ROUTE_RECALC_THRESHOLD_METERS &&
      ahora - lastDestinoRecalcAtRef.current >= 8000
    ) {
      lastDestinoRecalcAtRef.current = ahora;
      console.log(
        "🔄 Taxi fuera de la ruta al destino, recalculando desde su posición actual...",
      );
      setRutaDestinoEnCurso([]);
      setRouteRefreshToken((prev) => prev + 1);
    }
  }, [estado, taxiPos?.lat, taxiPos?.lng, rutaDestinoEnCurso]);

  const obtenerTextoEstado = () => {
    if (estado === "pendiente") return "ACTIVO";
    if (estado === "encurso") return "VIAJE EN CURSO";
    if (estado === "buscando") return "BUSCANDO...";
    return estado ? estado.toUpperCase() : "";
  };

  const handleLogout = () => {
    logout();
    socket.disconnect();
    navigate("/login");
  };

  const enCaminoUI = ["asignado", "encamino"].includes(estado);
  const compactoInferior = [
    "buscando",
    "preasignado",
    "asignado",
    "encamino",
    "encurso",
  ].includes(estado);
  const mostrarTextoBuscando =
    !taxistaAsignado && ["buscando", "preasignado"].includes(estado);

  const abrirSelectorDestino = () => {
    setSelectorDestinoAbierto(true);
    setDestinoColapsado(false);
    setDestinoConfirmado(false);

    // Pin provisional cerca del pasajero, sin crear una ruta.
    if (userPosition?.lat && userPosition?.lng) {
      const lat = Number(userPosition.lat);
      const lng = Number(userPosition.lng);

      // Aproximadamente 20 metros al norte del pasajero.
      const latOffset = 20 / 111320;

      setDestinationLat(lat + latOffset);
      setDestinationLng(lng);

      setDestinationAddress("");
      setDestinationQuery("");

      // No mostrar ruta mientras el destino sea provisional.
      setRutaDestinoPreview([]);
      setRutaDestinoEnCurso([]);
      setDistanciaRutaMapboxKm(null);
      setDistanciaEstimadaKm(null);
      setTarifaEstimada(null);
    }
  };

  useEffect(() => {
    if (enCaminoUI) {
      setDestinoColapsado(true);
      return;
    }

    if (estado === "pendiente" && !selectorDestinoAbierto) {
      setDestinoColapsado(false);
    }
  }, [enCaminoUI, estado, selectorDestinoAbierto]);

  useEffect(() => {
    if (chatAbierto) {
      setUnreadChatCount(0);
    }
  }, [chatAbierto]);

  const routePositionsEnCurso = useMemo(() => {
    if (rutaDestinoEnCurso.length > 0) {
      return rutaDestinoEnCurso;
    }

    return [] as L.LatLngExpression[];
  }, [rutaDestinoEnCurso]);

  /**
   * Waypoints estables para la ruta al destino. Sin esta memoización el
   * `RoutingMachine` recibía un array nuevo en cada render y su efecto volvía
   * a montar el control de Mapbox (una petición extra por render).
   */
  const waypointsRutaDestino = useMemo<L.LatLng[] | null>(() => {
    if (!taxiPos?.lat || !taxiPos?.lng || !destinationPosition) return null;

    return [
      L.latLng(Number(taxiPos.lat), Number(taxiPos.lng)),
      L.latLng(destinationPosition[0], destinationPosition[1]),
    ];
  }, [
    taxiPos?.lat,
    taxiPos?.lng,
    destinationPosition?.[0],
    destinationPosition?.[1],
  ]);

  /**
   * Waypoints estables para la ruta de aproximación (taxi → pasajero).
   */
  const waypointsRutaAproximacion = useMemo<L.LatLng[] | null>(() => {
    if (!taxiPos?.lat || !taxiPos?.lng) return null;
    if (!userPosition?.lat || !userPosition?.lng) return null;

    return [
      L.latLng(Number(taxiPos.lat), Number(taxiPos.lng)),
      L.latLng(Number(userPosition.lat), Number(userPosition.lng)),
    ];
  }, [taxiPos?.lat, taxiPos?.lng, userPosition?.lat, userPosition?.lng]);

  /**
   * Waypoints estables para la ruta del pasajero a su destino
   * (la que debe seguir viéndose durante `buscando`/`asignado`/`encamino`).
   */
  const waypointsRutaDestinoPreview = useMemo<L.LatLng[] | null>(() => {
    if (!userPosition?.lat || !userPosition?.lng) return null;
    if (!destinationPosition) return null;

    return [
      L.latLng(Number(userPosition.lat), Number(userPosition.lng)),
      L.latLng(destinationPosition[0], destinationPosition[1]),
    ];
  }, [
    userPosition?.lat,
    userPosition?.lng,
    destinationPosition?.[0],
    destinationPosition?.[1],
  ]);

  const handleRutaPreviewEncontrada = useCallback(
    ({ coords, distanceKm }: {
      coords: L.LatLng[];
      distanceKm: number | null;
      durationMin: number | null;
    }) => {
      setRutaDestinoPreview(sanitizeRouteTail(coords));

      // La tarifa sólo se recalcula mientras el pasajero aún elige destino; en
      // plena solicitud/viaje se respeta la que ya viaja en el viaje.
      if (estadoRef.current === "pendiente" && distanceKm !== null) {
        setDistanciaRutaMapboxKm(distanceKm);
        setDistanciaEstimadaKm(distanceKm);
        setTarifaEstimada(calcularTarifaPorDistancia(distanceKm));
      }
    },
    [],
  );

  const handleRutaAproximacionEncontrada = useCallback(
    ({ coords }: { coords: L.LatLng[] }) => {
      console.log(
        "🗺️ Nueva trayectoria de aproximación trazada. Puntos:",
        coords.length,
      );
      setGeometriaRuta(sanitizeRouteTail(coords));
    },
    [],
  );

  const handleRutaDestinoEncontrada = useCallback(
    ({ coords, distanceKm, durationMin }: {
      coords: L.LatLng[];
      distanceKm: number | null;
      durationMin: number | null;
    }) => {
      setRutaDestinoEnCurso(sanitizeRouteTail(coords));

      if (distanceKm !== null && Number.isFinite(distanceKm)) {
        const nuevaDistanciaKm = Number(distanceKm);
        const nuevaTarifa = calcularTarifaPorDistancia(nuevaDistanciaKm);

        setDistanciaRutaMapboxKm(nuevaDistanciaKm);
        setDistanciaEstimadaKm(nuevaDistanciaKm);
        setTarifaEstimada(nuevaTarifa);

        console.log("Nueva distancia vial al destino:", {
          distanceKm: nuevaDistanciaKm,
          fare: nuevaTarifa,
          durationMin,
        });

        actualizarDestinoEnServidor(
          destinationPosition?.[0] ?? null,
          destinationPosition?.[1] ?? null,
          destinationAddressRef.current ||
            destinationQuery ||
            "Destino no especificado",
          nuevaDistanciaKm,
          nuevaTarifa,
        );
      }
    },
    [
      actualizarDestinoEnServidor,
      destinationPosition?.[0],
      destinationPosition?.[1],
      destinationQuery,
    ],
  );

  useEffect(() => {
    if (
      estado === "encurso" &&
      taxiPos?.lat &&
      taxiPos?.lng &&
      destinationPosition &&
      rutaDestinoEnCurso.length === 0
    ) {
      console.log("RENDER ROUTING DESTINO", {
        estado,
        taxiPos,
        destinationPosition,
        rutaDestinoEnCursoLength: rutaDestinoEnCurso.length,
        routeRefreshToken,
      });
    }
  }, [
    estado,
    taxiPos?.lat,
    taxiPos?.lng,
    destinationPosition?.[0],
    destinationPosition?.[1],
    rutaDestinoEnCurso.length,
    routeRefreshToken,
  ]);

  return (
    <div className="h-dvh bg-slate-50 flex flex-col items-center font-sans relative overflow-hidden">
      <ToastContainer theme="light" />

      {/* Barra superior */}
      <div className="absolute top-0 left-0 w-full h-1 bg-[#22c55e] z-[2001]" />

      <main className="w-full max-w-md bg-white rounded-t-[2.5rem] shadow-2xl overflow-hidden border border-slate-100 relative flex flex-col flex-1 min-h-0">
        {/* =========================================================
          HEADER SOBRE EL MAPA
      ========================================================= */}
        <div className="absolute top-4 left-4 right-4 z-[1002] flex items-center justify-between pointer-events-none">
          <div className="bg-slate-900/75 backdrop-blur-md px-3 py-1.5 rounded-full shadow-lg">
            <h1 className="text-[11px] font-black text-white tracking-tight uppercase italic">
              VALLES<span className="text-[#22c55e]">VIAJE</span>
            </h1>
          </div>

          <div className="flex items-center gap-2 bg-white/95 px-3 py-1.5 rounded-full border border-slate-200 shadow-lg backdrop-blur-sm">
            <div
              className={`h-2 w-2 rounded-full ${
                userPosition?.lat && userPosition?.lng
                  ? "bg-[#22c55e]"
                  : "bg-red-500 animate-pulse"
              }`}
            />

            <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">
              GPS
            </span>
          </div>
        </div>

        {/* =========================================================
          BOTÓN SALIR
      ========================================================= */}
        <div className="absolute top-[4.5rem] left-4 z-[1002]">
          <button
            onClick={handleLogout}
            className="bg-white/95 backdrop-blur-md text-slate-500 border border-slate-200 px-3 py-1.5 rounded-full text-[8px] font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all"
          >
            Salir
          </button>
        </div>

        {/* =========================================================
          AVISO DE CONEXIÓN
      ========================================================= */}
        {!socketConectado && (
          <div className="absolute top-[7.25rem] left-4 z-[1002] flex items-center gap-1.5 bg-red-500 text-white px-2.5 py-1 rounded-full shadow-lg animate-pulse">
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
            <span className="text-[8px] font-black uppercase tracking-widest">
              Sin conexión · reconectando
            </span>
          </div>
        )}

        {/* =========================================================
          BADGE DE ESTADO
      ========================================================= */}
        <div className="absolute top-[4.5rem] right-4 z-[1002]">
          <div
            className={`px-3 py-1.5 rounded-full text-[8px] font-black uppercase tracking-widest flex items-center gap-2 shadow-lg backdrop-blur-md transition-all duration-500 ${
              estado === "encurso"
                ? "bg-slate-900/85 text-white"
                : estado === "buscando"
                  ? "bg-amber-500 text-white animate-pulse"
                  : estado === "encamino"
                    ? "bg-[#22c55e] text-white"
                    : estado === "asignado"
                      ? "bg-[#22c55e] text-white"
                      : "bg-white/95 text-slate-600"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                estado === "buscando"
                  ? "bg-white animate-ping"
                  : estado === "encurso"
                    ? "bg-[#22c55e]"
                    : "bg-white"
              }`}
            />

            {obtenerTextoEstado()}
          </div>
        </div>

        {/* =========================================================
          MAPA
      ========================================================= */}
        <div className="flex-1 min-h-[250px] w-full relative bg-slate-100">
          {userPosition?.lat && userPosition?.lng ? (
            <MapContainer
              center={[userPosition.lat, userPosition.lng]}
              zoom={15}
              className="h-full w-full"
              zoomControl={false}
            >
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

              {/* Mantener el taxi en el encuadre durante el viaje */}
              <MapAutoFollow
                lat={
                  ["asignado", "encamino", "encurso"].includes(estado)
                    ? (taxiPos?.lat ?? null)
                    : (userPosition?.lat ?? null)
                }
                lng={
                  ["asignado", "encamino", "encurso"].includes(estado)
                    ? (taxiPos?.lng ?? null)
                    : (userPosition?.lng ?? null)
                }
                activo={Boolean(
                  ["asignado", "encamino", "encurso"].includes(estado)
                    ? taxiPos?.lat && taxiPos?.lng
                    : userPosition?.lat && userPosition?.lng,
                )}
              />

              {/* -----------------------------------------------------
                PASAJERO
            ----------------------------------------------------- */}
              {estado !== "encurso" && (
                <Marker
                  position={[userPosition.lat, userPosition.lng]}
                  icon={pasajeroIcon}
                  zIndexOffset={100}
                >
                  <Popup>{userPosition.name || "Tu ubicación"}</Popup>
                </Marker>
              )}

              {/* -----------------------------------------------------
                DESTINO
            ----------------------------------------------------- */}
              {destinationPosition && (
                <Marker
                  position={destinationPosition}
                  icon={destinationMarkerIcon}
                  zIndexOffset={1000}
                  draggable={estado === "encurso" || selectorDestinoAbierto}
                  eventHandlers={
                    estado === "encurso" || selectorDestinoAbierto
                      ? {
                          dragend: (event) => {
                            const marker = event.target as L.Marker;
                            const next = marker.getLatLng();

                            void actualizarDestinoDesdeMarker(
                              next.lat,
                              next.lng,
                            );
                          },
                        }
                      : undefined
                  }
                >
                  <Popup>Destino</Popup>
                </Marker>
              )}

              {/* -----------------------------------------------------
                PREVIEW DE DESTINO
            ----------------------------------------------------- */}
              {destinationPosition &&
                estado !== "encurso" &&
                rutaDestinoPreview.length > 0 && (
                  <Polyline
                    positions={rutaDestinoPreview}
                    pathOptions={{
                      color: "#22c55e",
                      weight: 4,
                      opacity: 0.85,
                      lineJoin: "round",
                      lineCap: "round",
                    }}
                  />
                )}

              {/* -----------------------------------------------------
                ROUTING DESTINO PREVIEW
            ----------------------------------------------------- */}
              {ESTADOS_CON_RUTA_DESTINO.includes(estado) &&
                destinationAddress &&
                rutaDestinoPreview.length === 0 &&
                waypointsRutaDestinoPreview && (
                  <Suspense fallback={null}>
                    <RoutingMachine
                      key={`preview-${destinationPosition?.[0]}-${destinationPosition?.[1]}-${estado}`}
                      waypoints={waypointsRutaDestinoPreview}
                      onRouteFound={handleRutaPreviewEncontrada}
                    />
                  </Suspense>
                )}

              {/* -----------------------------------------------------
                TAXI
            ----------------------------------------------------- */}
              {taxiPos &&
                ["asignado", "encamino", "encurso"].includes(estado) && (
                  <RotatedMarker
                    position={[taxiPos.lat, taxiPos.lng]}
                    icon={taxistaIcon}
                    rotationAngle={taxiPos.heading || 0}
                  >
                    <Popup>Unidad {taxistaAsignado?.taxiNumber}</Popup>
                  </RotatedMarker>
                )}

              {/* -----------------------------------------------------
                RUTA DE APROXIMACIÓN
            ----------------------------------------------------- */}
              {["asignado", "encamino"].includes(estado) &&
                geometriaRuta.length > 0 && (
                  <Polyline
                    positions={geometriaRuta}
                    pathOptions={{
                      color: "rgb(245, 33, 65)",
                      weight: 5,
                      lineJoin: "round",
                      lineCap: "round",
                    }}
                  />
                )}

              {/* -----------------------------------------------------
                ROUTING TAXI → PASAJERO (EN CAMINO)
              ----------------------------------------------------- */}
              {["asignado", "encamino"].includes(estado) &&
                geometriaRuta.length === 0 &&
                waypointsRutaAproximacion && ( // 🚨 evitar el bucle: sólo se pide ruta si no hay ninguna
                  <Suspense fallback={null}>
                    <RoutingMachine
                      key={`approach-${routeRefreshToken}-${estado}`}
                      waypoints={waypointsRutaAproximacion}
                      onRouteFound={handleRutaAproximacionEncontrada}
                    />
                  </Suspense>
                )}

              {/* -----------------------------------------------------
                RASTRO DEL VIAJE
            ----------------------------------------------------- */}
              {estado === "encurso" && historialRuta.length > 0 && (
                <Polyline
                  positions={historialRuta}
                  pathOptions={{
                    color: "#22c55e",
                    weight: 4,
                    lineJoin: "round",
                  }}
                />
              )}

              {/* -----------------------------------------------------
                ROUTING AL DESTINO
            ----------------------------------------------------- */}
              {estado === "encurso" &&
                rutaDestinoEnCurso.length === 0 &&
                waypointsRutaDestino && (
                  <Suspense fallback={null}>
                    <RoutingMachine
                      key={`destination-${routeRefreshToken}-${destinationPosition?.[0]}-${destinationPosition?.[1]}-${estado}`}
                      waypoints={waypointsRutaDestino}
                      onRouteFound={handleRutaDestinoEncontrada}
                    />
                  </Suspense>
                )}

              {/* -----------------------------------------------------
                LÍNEA AL DESTINO
            ----------------------------------------------------- */}
              {estado === "encurso" && routePositionsEnCurso.length > 0 && (
                <Polyline
                  positions={routePositionsEnCurso}
                  pathOptions={{
                    color: "#22c55e",
                    weight: 5,
                    lineJoin: "round",
                    lineCap: "round",
                  }}
                />
              )}
            </MapContainer>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="h-10 w-10 rounded-full border-4 border-slate-200 border-t-[#22c55e] animate-spin" />

              <p className="text-slate-400 font-black text-[9px] uppercase tracking-widest">
                Buscando tu ubicación...
              </p>
            </div>
          )}

          {/* =======================================================
    SELECTOR DE DESTINO
======================================================= */}
          {selectorDestinoAbierto &&
            !destinoColapsado &&
            estado === "pendiente" && (
              <div className="absolute left-0 right-0 bottom-0 z-[1300] bg-white/97 backdrop-blur-md border border-green-200 rounded-t-[2rem] shadow-[0_0_10px_rgba(34,197,94,0.28),inset_0_-1px_0_rgba(34,197,94,0.45)] p-4 pb-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[8px] font-black uppercase tracking-[0.2em] text-[#22c55e]">
                      Destino
                    </p>

                    <p className="text-[11px] font-bold text-slate-700 truncate">
                      {destinationAddress || "¿A dónde quieres ir?"}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectorDestinoAbierto(false);
                      setDestinoColapsado(false);
                    }}
                    className="text-[8px] font-black uppercase tracking-widest text-slate-400"
                  >
                    Cerrar
                  </button>
                </div>

                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm">
                      📍
                    </span>

                    <input
                      value={destinationQuery}
                      onChange={(e) => setDestinationQuery(e.target.value)}
                      placeholder="Calle, colonia o lugar"
                      className="w-full bg-slate-100 border border-slate-200 rounded-2xl pl-9 pr-3 py-3 text-sm font-medium text-slate-800 outline-none focus:ring-2 focus:ring-[#22c55e]/30"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => void geocodificarDestino(destinationQuery)}
                    disabled={
                      isSearchingDestination || !destinationQuery.trim()
                    }
                    className="px-4 rounded-2xl bg-[#22c55e] text-white font-black text-[9px] uppercase tracking-widest disabled:opacity-50 active:scale-95 transition-all"
                  >
                    {isSearchingDestination ? "..." : "Buscar"}
                  </button>
                </div>

                {tarifaEstimada !== null && distanciaEstimadaKm !== null && (
                  <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-2xl px-3 py-2.5">
                    <div>
                      <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">
                        Distancia
                      </p>

                      <p className="text-sm font-black text-slate-800">
                        {distanciaEstimadaKm.toFixed(1)} km
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">
                        Tarifa estimada
                      </p>

                      <p className="text-sm font-black text-slate-800">
                        ${tarifaEstimada} MXN
                      </p>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setDestinoConfirmado(true);
                    setSelectorDestinoAbierto(false);
                    setDestinoColapsado(true);
                  }}
                  disabled={destinationLat === null || destinationLng === null}
                  className="w-full py-3 rounded-2xl bg-[#22c55e] text-white font-black text-[10px] uppercase tracking-widest disabled:opacity-40 active:scale-95 transition-all"
                >
                  CONFIRMAR DESTINO
                </button>

                <p className="text-[7px] font-bold text-slate-400 uppercase tracking-[0.16em] text-center">
                  Arrastra el pin verde para ajustar la ubicación
                </p>
              </div>
            )}
        </div>

        {/* =========================================================
    TARJETA DEL TAXISTA
========================================================= */}
        {taxistaAsignado && ["asignado", "encamino"].includes(estado) && (
          <div className="relative z-[1100] mx-4 -mt-5">
            <div className="bg-slate-50 border border-green-200 rounded-2xl p-3 shadow-[0_0_10px_rgba(34,197,94,0.28),inset_0_-1px_0_rgba(34,197,94,0.45)]">
              {/* CABECERA DE LA UNIDAD */}
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 shrink-0 bg-green-50 rounded-2xl flex items-center justify-center text-xl">
                  🚕
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-[7px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Tu unidad
                  </p>

                  <p className="text-[12px] font-black text-slate-800 truncate">
                    {taxistaAsignado.name || "Unidad asignada"}
                  </p>

                  <p className="text-[9px] font-black text-[#22c55e] uppercase tracking-widest">
                    TAXI {taxistaAsignado.taxiNumber || "ECO"}
                  </p>
                </div>

                {/* ESTADO */}
                <div className="shrink-0">
                  <div
                    className={`px-2.5 py-1.5 rounded-xl ${
                      estado === "encamino" ? "bg-green-50" : "bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          estado === "encamino"
                            ? "bg-[#22c55e] animate-pulse"
                            : "bg-slate-400"
                        }`}
                      />

                      <span
                        className={`text-[7px] font-black uppercase tracking-widest ${
                          estado === "encamino"
                            ? "text-[#22c55e]"
                            : "text-slate-500"
                        }`}
                      >
                        {estado === "encamino" ? "En camino" : "Asignado"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* INFORMACIÓN GPS */}
              {estado === "encamino" && (
                <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">
                      Estado
                    </p>

                    <p className="text-[9px] font-bold text-slate-700 truncate">
                      Tu taxi se dirige hacia ti
                    </p>
                  </div>

                  <div className="shrink-0 ml-3 px-2.5 py-1.5 rounded-xl bg-green-50">
                    <div className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#22c55e] animate-pulse" />

                      <span className="text-[7px] font-black text-[#22c55e] uppercase tracking-widest">
                        GPS EN VIVO
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {/* =========================================================
          PANEL INFERIOR
      ========================================================= */}
        {!selectorDestinoAbierto && (
          <div
            className={`${
              compactoInferior ? "px-4 pt-3 pb-10" : "px-5 pt-4 pb-12"
            } flex flex-col shrink-0 bg-white transition-all duration-300`}
          >
            {/* -------------------------------------------------------
            PENDIENTE
        ------------------------------------------------------- */}
            {estado === "pendiente" && (
              <div className="space-y-3">
                <div>
                  <p className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em]">
                    Servicio Valles
                  </p>

                  {destinoConfirmado ? (
                    <>
                      <h2 className="text-sm font-black text-slate-900 tracking-tight">
                        📍{" "}
                        {destinationAddress ||
                          destinationQuery ||
                          "Destino confirmado"}
                      </h2>

                      <div className="grid grid-cols-2 gap-3 mt-2">
                        {/* TARIFA */}
                        <div className="text-left">
                          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                            Tarifa estimada
                          </p>
                          <p className="text-lg font-black text-slate-700">
                            {tarifaEstimada !== null
                              ? `$${Math.round(tarifaEstimada)}`
                              : "Calculando..."}
                          </p>
                        </div>

                        {/* DISTANCIA */}
                        <div className="text-right">
                          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                            Distancia
                          </p>
                          <p className="text-lg font-black text-slate-700">
                            {distanciaEstimadaKm !== null
                              ? `${distanciaEstimadaKm.toFixed(1)} km`
                              : "Calculando..."}
                          </p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <h2 className="text-xl font-black text-slate-900 tracking-tight">
                        ¿A dónde vamos hoy?
                      </h2>

                      <p className="text-[10px] text-slate-400 mt-1">
                        Solicita una unidad cercana en segundos.
                      </p>
                    </>
                  )}
                </div>

                {!selectorDestinoAbierto && (
                  <button
                    type="button"
                    onClick={abrirSelectorDestino}
                    className="w-full text-left bg-slate-50 border border-green-200 rounded-2xl p-3 flex items-center gap-3 shadow-[0_0_10px_rgba(34,197,94,0.28),inset_0_-1px_0_rgba(34,197,94,0.45)] active:scale-[0.99] transition-all"
                  >
                    <div className="h-9 w-9 bg-white rounded-xl flex items-center justify-center shadow-sm">
                      📍
                    </div>

                    <div className="flex-1">
                      <p className="text-[10px] font-bold text-slate-600">
                        Selecciona tu destino
                      </p>
                    </div>

                    <span className="text-[#22c55e] font-black">→</span>
                  </button>
                )}

                {destinoConfirmado && !searchFlowActivo && (
                  <button
                    onClick={solicitarTaxi}
                    className="w-full py-4 rounded-2xl bg-[#22c55e] text-white font-black text-[11px] tracking-widest shadow-xl shadow-green-900/20 hover:bg-[#16a34a] active:scale-[0.98] transition-all"
                  >
                    SOLICITAR TRANSPORTE
                  </button>
                )}
              </div>
            )}

            {/* -------------------------------------------------------
            BUSCANDO
        ------------------------------------------------------- */}
            {estado === "buscando" && (
              <div className="space-y-3">
                <div>
                  <p className="text-[8px] font-black text-amber-500 uppercase tracking-[0.2em]">
                    Solicitud activa
                  </p>

                  <h2 className="text-lg font-black text-slate-900">
                    Buscando una unidad...
                  </h2>

                  <p className="text-[9px] text-slate-400 mt-1">
                    Te avisaremos cuando un taxista acepte.
                  </p>
                </div>

                <button
                  onClick={cancelarSolicitud}
                  className="w-full py-3 rounded-2xl bg-red-50 text-red-500 border border-red-100 font-black text-[9px] uppercase tracking-widest active:bg-red-100 transition-all"
                >
                  Cancelar solicitud
                </button>
              </div>
            )}

            {/* -------------------------------------------------------
    ASIGNADO / EN CAMINO
------------------------------------------------------- */}
            {["asignado", "encamino"].includes(estado) && taxistaAsignado && (
              <div className="space-y-3">
                {/* DESTINO */}
                {(destinationAddress ||
                  taxistaAsignado?.destinationAddress) && (
                  <div className="bg-slate-50 border border-green-200 rounded-2xl p-3 shadow-[0_0_10px_rgba(34,197,94,0.28),inset_0_-1px_0_rgba(34,197,94,0.45)]">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 shrink-0 rounded-xl bg-green-50 flex items-center justify-center">
                        📍
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">
                          Destino
                        </p>

                        <div className="address-marquee">
                          <div className="address-marquee-track">
                            <span className="!text-slate-700">
                              {destinationAddress ||
                                taxistaAsignado?.destinationAddress}
                            </span>

                            <span
                              aria-hidden="true"
                              className="!text-slate-700"
                            >
                              {destinationAddress ||
                                taxistaAsignado?.destinationAddress}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* DISTANCIA + TARIFA */}
                {tarifaEstimada !== null && distanciaEstimadaKm !== null && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-slate-50 border border-green-200 rounded-2xl p-3 shadow-[0_0_10px_rgba(34,197,94,0.28),inset_0_-1px_0_rgba(34,197,94,0.45)]">
                      <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">
                        Distancia
                      </p>

                      <p className="text-lg font-black text-slate-800 mt-0.5">
                        {distanciaEstimadaKm.toFixed(1)}
                        <span className="text-[9px] font-bold text-slate-400 ml-1">
                          km
                        </span>
                      </p>
                    </div>

                    <div className="bg-slate-50 border border-green-200 rounded-2xl p-3 shadow-[0_0_10px_rgba(34,197,94,0.28),inset_0_-1px_0_rgba(34,197,94,0.45)]">
                      <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">
                        Tarifa estimada
                      </p>

                      <p className="text-lg font-black text-slate-800 mt-0.5">
                        ${Math.round(tarifaEstimada)}
                        <span className="text-[9px] font-bold text-slate-400 ml-1">
                          MXN
                        </span>
                      </p>
                    </div>
                  </div>
                )}

                {/* CANCELAR */}
                <button
                  onClick={cancelarSolicitud}
                  className="w-full py-2.5 rounded-2xl bg-red-50 text-red-500 border border-red-100 font-black text-[8px] uppercase tracking-widest active:bg-red-100 transition-all"
                >
                  Cancelar solicitud
                </button>
              </div>
            )}
            {/* -------------------------------------------------------
            EN CURSO
        ------------------------------------------------------- */}
            {estado === "encurso" && (
              <div className="space-y-3">
                <div>
                  <p className="text-[8px] font-black text-[#22c55e] uppercase tracking-[0.2em]">
                    Viaje en curso
                  </p>

                  <h2 className="text-lg font-black text-slate-900">
                    Buen viaje por Valles
                  </h2>

                  <p className="text-[9px] text-slate-400 mt-1">
                    Tu ruta hacia el destino está activa.
                  </p>
                </div>

                {(destinationAddress ||
                  taxistaAsignado?.destinationAddress) && (
                  <div className="bg-slate-50 border border-green-200 rounded-2xl p-3 shadow-[0_0_10px_rgba(34,197,94,0.28),inset_0_-1px_0_rgba(34,197,94,0.45)] flex items-center gap-3">
                    <div className="h-9 w-9 shrink-0 rounded-xl bg-green-50 flex items-center justify-center">
                      📍
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">
                        Destino
                      </p>

                      {/* 🎯 MISMO MARQUEE QUE TAXISTAVIEW */}
                      <div className="address-marquee">
                        <div className="address-marquee-track">
                          <span className="!text-slate-700">
                            {destinationAddress ||
                              taxistaAsignado?.destinationAddress}
                          </span>

                          <span aria-hidden="true" className="!text-slate-700">
                            {destinationAddress ||
                              taxistaAsignado?.destinationAddress}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {tarifaEstimada !== null && distanciaEstimadaKm !== null && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-slate-50 border border-green-200 rounded-2xl p-3 shadow-[0_0_10px_rgba(34,197,94,0.28),inset_0_-1px_0_rgba(34,197,94,0.45)]">
                      <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">
                        Distancia
                      </p>

                      <p className="text-base font-black text-slate-800">
                        {distanciaEstimadaKm.toFixed(1)} km
                      </p>
                    </div>

                    <div className="bg-slate-50 border border-green-200 rounded-2xl p-3 shadow-[0_0_10px_rgba(34,197,94,0.28),inset_0_-1px_0_rgba(34,197,94,0.45)]">
                      <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">
                        Tarifa estimada
                      </p>

                      <p className="text-base font-black text-slate-800">
                        ${tarifaEstimada} MXN
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* ===========================================================
        CHAT
    =========================================================== */}
      {taxistaAsignado?.email && ["asignado", "encamino"].includes(estado) && (
        <>
          {/* Panel */}
          <div
            className={`fixed z-[2000] bottom-24 ${
              chatPanelOnLeft ? "left-3 sm:left-4" : "right-3 sm:right-4"
            } left-3 sm:left-auto sm:w-[340px] bg-white border border-slate-100 rounded-3xl shadow-2xl overflow-hidden transition-all duration-200 ${
              chatAbierto
                ? "opacity-100 visible scale-100"
                : "opacity-0 invisible pointer-events-none scale-95"
            }`}
          >
            <div className="h-12 px-4 flex items-center justify-between bg-white border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>

                <span className="text-[9px] font-black text-slate-800 uppercase tracking-widest">
                  Chat con unidad
                </span>
              </div>

              <button
                onClick={() => setChatAbierto(false)}
                className="text-slate-400 hover:text-slate-800 text-xs font-black"
              >
                ✕
              </button>
            </div>

            <div className="h-[280px] bg-white">
              <ChatBox
                toEmail={
                  taxistaAsignado.email ||
                  (taxistaAsignado as any).taxistaEmail ||
                  ""
                }
                userName={userPosition?.name || "Pasajero"}
                onIncomingMessage={() => {
                  if (!chatAbierto) {
                    setUnreadChatCount((prev) => Math.min(prev + 1, 99));
                  }
                }}
              />
            </div>
          </div>

          {/* Burbuja */}
          {!chatAbierto && (
            <button
              onPointerDown={handleChatBubblePointerDown}
              onPointerMove={handleChatBubblePointerMove}
              onPointerUp={finishChatBubbleDrag}
              onPointerCancel={finishChatBubbleDrag}
              style={{
                left: `${chatBubbleX ?? CHAT_BUBBLE_MARGIN}px`,
              }}
              className={`fixed z-[2000] bottom-24 h-[54px] w-[54px] bg-[#22c55e] text-white rounded-full border-b-4 border-[#15803d] shadow-2xl font-black text-lg flex items-center justify-center active:translate-y-1 select-none transition-all ${
                unreadChatCount > 0
                  ? "animate-pulse ring-4 ring-[#22c55e]/40"
                  : ""
              }`}
              title="Chat con unidad"
              aria-label="Abrir chat con unidad"
              data-dragging={isDraggingChatBubble ? "true" : "false"}
            >
              💬
              {unreadChatCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[19px] h-[19px] px-1 rounded-full bg-red-500 border-2 border-white text-[9px] leading-none font-black flex items-center justify-center text-white">
                  {unreadChatCount > 9 ? "9+" : unreadChatCount}
                </span>
              )}
            </button>
          )}
        </>
      )}

      {/* ===========================================================
        FINALIZACIÓN
    =========================================================== */}
      {estado === "finalizado" && (
        <div className="fixed inset-0 z-[3000] bg-[#22c55e] flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in">
          <div className="bg-white rounded-[2.5rem] p-8 shadow-2xl flex flex-col items-center text-center max-w-xs w-full">
            <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center text-4xl mb-5">
              ✓
            </div>

            <p className="text-[8px] font-black uppercase tracking-[0.25em] text-[#22c55e] mb-2">
              VallesViaje
            </p>

            <div className="text-2xl font-black text-slate-800 tracking-tight mb-2">
              ¡Viaje finalizado!
            </div>

            <p className="text-[10px] text-slate-400 font-medium mb-6">
              Gracias por viajar con nosotros.
            </p>

            <button
              onClick={resetearApp}
              className="w-full py-4 bg-[#22c55e] text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg active:scale-95 transition-all"
            >
              Continuar
            </button>
          </div>
        </div>
      )}

      {/* ===========================================================
        REHIDRATACIÓN
    =========================================================== */}
      {isRehydrating && (
        <div className="fixed inset-0 bg-[#0f172a]/90 backdrop-blur-md z-[3000] flex flex-col items-center justify-center gap-5">
          <div className="relative">
            <div className="w-14 h-14 border-4 border-white/20 border-t-[#22c55e] rounded-full animate-spin" />

            <div className="absolute inset-0 flex items-center justify-center text-lg">
              🚕
            </div>
          </div>

          <div className="text-center">
            <p className="text-white font-black uppercase tracking-widest text-sm">
              Recuperando viaje
            </p>

            <p className="text-white/50 text-[8px] font-bold uppercase tracking-widest mt-1">
              Restaurando tu conexión...
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default PasajeroView;
