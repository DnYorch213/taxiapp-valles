import React, { Suspense, lazy, useState, useEffect, useMemo, useRef, useCallback } from "react";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { socket } from "../lib/socket";
import { useTravel } from "../context/TravelContext";
import { useNavigate } from "react-router-dom";
import { useGeolocation } from "../hooks/useGeolocation";
import { Payload, ViajeEstado } from "../types/Payload";
import { ChatBox } from "../components/ChatBox";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { taxistaIcon, pasajeroIcon } from "../utils/icons";
import RotatedMarker from "../components/RotatedMarker";
import { calcularHeading } from "../utils/heading";
import { TRIP_STATES } from "../constants/states";

const RoutingMachine = lazy(() =>
  import("../components/RoutingMachine").then((module) => ({
    default: module.RoutingMachine,
  }))
);

const destinationMarkerIcon = L.divIcon({
  className: "",
  html: '<div class="h-9 w-9 rounded-full bg-[#22c55e] text-[#0f172a] shadow-xl border-2 border-white flex items-center justify-center text-xl">📍</div>',
  iconSize: [36, 36],
  iconAnchor: [18, 36],
});

const PasajeroView: React.FC = () => {
  const CHAT_BUBBLE_SIZE = 52;
  const CHAT_BUBBLE_MARGIN = 12;

  const { userPosition, setUserPosition, taxiPos, setTaxiPos, logout } = useTravel();
  const navigate = useNavigate();
  const [estado, setEstado] = useState<ViajeEstado>(TRIP_STATES.PENDIENTE);
  const [taxistaAsignado, setTaxistaAsignado] = useState<Payload | null>(null);
  const [searchFlowActivo, setSearchFlowActivo] = useState(false);
  const [chatAbierto, setChatAbierto] = useState(false);
  const [chatBubbleX, setChatBubbleX] = useState<number | null>(null);
  const [isDraggingChatBubble, setIsDraggingChatBubble] = useState(false);
  const [destinationQuery, setDestinationQuery] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [destinationLat, setDestinationLat] = useState<number | null>(null);
  const [destinationLng, setDestinationLng] = useState<number | null>(null);
  const [destinoColapsado, setDestinoColapsado] = useState(false);
  const [isSearchingDestination, setIsSearchingDestination] = useState(false);
  const [historialRuta, setHistorialRuta] = useState<L.LatLngExpression[]>([]);
  const [geometriaRuta, setGeometriaRuta] = useState<L.LatLngExpression[]>([]);

  // REFS CENTRALIZADAS - Evitan closures obsoletos en listeners
  const taxistaAsignadoRef = useRef<Payload | null>(null);
  const estadoRef = useRef<ViajeEstado>(TRIP_STATES.PENDIENTE);
  const taxiPosRef = useRef<any>(null);
  const userPositionRef = useRef<any>(null);
  const chatDragRef = useRef({
    startPointerX: 0,
    startBubbleX: 0,
    moved: false,
  });

  // Sincronización de refs (un solo efecto para todas)
  useEffect(() => { taxistaAsignadoRef.current = taxistaAsignado; }, [taxistaAsignado]);
  useEffect(() => { estadoRef.current = estado; }, [estado]);
  useEffect(() => { taxiPosRef.current = taxiPos; }, [taxiPos]);
  useEffect(() => { userPositionRef.current = userPosition; }, [userPosition]);

  useEffect(() => {
    const savedQuery = localStorage.getItem("taxi_destination_query") || "";
    const savedAddress = localStorage.getItem("taxi_destination_address") || "";
    const savedLat = localStorage.getItem("taxi_destination_lat");
    const savedLng = localStorage.getItem("taxi_destination_lng");

    if (savedQuery) setDestinationQuery(savedQuery);
    if (savedAddress) setDestinationAddress(savedAddress);
    if (savedLat && savedLng) {
      const latNum = Number(savedLat);
      const lngNum = Number(savedLng);
      if (!Number.isNaN(latNum) && !Number.isNaN(lngNum)) {
        setDestinationLat(latNum);
        setDestinationLng(lngNum);
      }
    }
  }, []);

  useEffect(() => {
    if (destinationQuery) localStorage.setItem("taxi_destination_query", destinationQuery);
    else localStorage.removeItem("taxi_destination_query");
  }, [destinationQuery]);

  useEffect(() => {
    if (destinationAddress) localStorage.setItem("taxi_destination_address", destinationAddress);
    else localStorage.removeItem("taxi_destination_address");
  }, [destinationAddress]);

  useEffect(() => {
    if (destinationLat !== null && destinationLng !== null) {
      localStorage.setItem("taxi_destination_lat", String(destinationLat));
      localStorage.setItem("taxi_destination_lng", String(destinationLng));
      return;
    }

    localStorage.removeItem("taxi_destination_lat");
    localStorage.removeItem("taxi_destination_lng");
  }, [destinationLat, destinationLng]);

  // GEOCONFIG ESTABLE - Solo cambia cuando el email cambia realmente
  const geoConfig = useMemo(() => ({
    email: userPosition?.email || "",
    name: userPosition?.name || "Pasajero",
    role: "pasajero" as const,
  }), [userPosition?.email, userPosition?.name]);

  // GPS con callback estable usando refs
  const handlePositionUpdate = useCallback((pos: any) => {
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
  }, [setUserPosition]);

  useGeolocation(geoConfig, handlePositionUpdate);

  const destinationPosition = useMemo<[number, number] | null>(() => {
    if (destinationLat === null || destinationLng === null) return null;
    return [destinationLat, destinationLng];
  }, [destinationLat, destinationLng]);

  useEffect(() => {
    if (destinationLat !== null && destinationLng !== null) return;
    if (!userPosition?.lat || !userPosition?.lng) return;

    setDestinationLat(userPosition.lat);
    setDestinationLng(userPosition.lng);
  }, [userPosition?.lat, userPosition?.lng, destinationLat, destinationLng]);

  const limpiarDestino = useCallback(() => {
    setDestinationQuery("");
    setDestinationAddress("");
    setDestinationLat(userPosition?.lat ?? null);
    setDestinationLng(userPosition?.lng ?? null);
  }, [userPosition?.lat, userPosition?.lng]);

  const geocodificarDestino = useCallback(async (query: string) => {
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

      const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("No se pudo buscar la dirección");

      const results = await response.json();
      if (!Array.isArray(results) || results.length === 0) {
        toast.error("No encontré esa ubicación. Prueba con otra dirección.");
        return;
      }

      const match = results[0];
      const latNum = Number(match.lat);
      const lngNum = Number(match.lon);

      if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
        toast.error("La ubicación encontrada no es válida.");
        return;
      }

      setDestinationLat(latNum);
      setDestinationLng(lngNum);
      setDestinationAddress(match.display_name || cleanQuery);
      setDestinationQuery(match.display_name || cleanQuery);
      toast.success("Destino ubicado en el mapa.");
    } catch (error) {
      console.warn("Error buscando destino:", error);
      toast.error("No pude buscar el destino en este momento.");
    } finally {
      setIsSearchingDestination(false);
    }
  }, []);

  const actualizarDestinoDesdeMarker = useCallback(async (lat: number, lng: number) => {
    setDestinationLat(lat);
    setDestinationLng(lng);

    try {
      const url = new URL("https://nominatim.openstreetmap.org/reverse");
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lng));
      url.searchParams.set("zoom", "18");
      url.searchParams.set("addressdetails", "1");

      const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("No se pudo resolver la dirección");

      const data = await response.json();
      const label = data.display_name || `Ubicación ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      setDestinationAddress(label);
      setDestinationQuery(label);
    } catch (error) {
      console.warn("Error resolviendo destino:", error);
      const label = `Ubicación ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      setDestinationAddress(label);
      setDestinationQuery(label);
    }
  }, []);

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
      setChatBubbleX((current) => (current === null ? current : clampBubbleX(current)));
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [chatBubbleX, clampBubbleX]);

  const handleChatBubblePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
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

  const handleChatBubblePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!isDraggingChatBubble) return;

    const deltaX = event.clientX - chatDragRef.current.startPointerX;
    if (Math.abs(deltaX) > 3) {
      chatDragRef.current.moved = true;
    }

    const nextX = clampBubbleX(chatDragRef.current.startBubbleX + deltaX);
    setChatBubbleX(nextX);
  };

  const finishChatBubbleDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!isDraggingChatBubble) return;

    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDraggingChatBubble(false);

    if (typeof window === "undefined") return;

    const currentX = chatBubbleX ?? CHAT_BUBBLE_MARGIN;
    const snapLeft = CHAT_BUBBLE_MARGIN;
    const snapRight = window.innerWidth - CHAT_BUBBLE_SIZE - CHAT_BUBBLE_MARGIN;
    const middle = window.innerWidth / 2;
    const nextSnap = currentX + CHAT_BUBBLE_SIZE / 2 < middle ? snapLeft : snapRight;

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
  // ­ LISTENERS DE SOCKET - SIN DEPENDENCIAS VOLÁTILES
  // ============================================================
  useEffect(() => {
    if (!socket) return;

    // ACEPTACIÓN DEL TAXI (sin setTimeout innecesario)
    socket.on("response_from_taxi", (data) => {
      console.log("­Respuesta del taxi recibida:", data);

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

        if (data.lat && data.lng) {
          setTaxiPos({ lat: data.lat, lng: data.lng, heading: 0 });
        } else {
          setTaxiPos(null);
        }
        setHistorialRuta([]);

        toast.success(`¡La Unidad ${data.taxiNumber} (${data.name}) va en camino!`, {
          position: "top-center",
          autoClose: 5000,
        });
      }
    });

    // TAXI MOVIDO (con orientación geográfica)
    socket.on("taxi_moved", (data: any) => {
      const emailAsignado = taxistaAsignadoRef.current?.email?.toLowerCase().trim();
      const emailEntrante = (data.tEmail || data.email || data.taxistaEmail)?.toLowerCase().trim();

      if (emailAsignado && emailEntrante === emailAsignado) {
        const latNum = Number(data.lat);
        const lngNum = Number(data.lng);
        const posAnterior = taxiPosRef.current;
        const pasajeroPos = userPositionRef.current;

        const nuevoHeading = calcularHeading(
          posAnterior ? { lat: posAnterior.lat, lng: posAnterior.lng } : null,
          { lat: latNum, lng: lngNum },
          pasajeroPos ? { lat: Number(pasajeroPos.lat), lng: Number(pasajeroPos.lng) } : null,
          estadoRef.current,
          posAnterior?.heading || 0
        );

        setTaxiPos({ lat: latNum, lng: lngNum, heading: nuevoHeading || 0 });

        if (pasajeroPos?.lat && pasajeroPos?.lng) {
          setGeometriaRuta([
            L.latLng(latNum, lngNum),
            L.latLng(Number(pasajeroPos.lat), Number(pasajeroPos.lng)),
          ]);
        }
      }
    });

    // ACTUALIZACIÓN DE RUTA EN CURSO
socket.on("update_trip_path", (data: { lat: number; lng: number }) => {
  const latNum = Number(data.lat);
  const lngNum = Number(data.lng);

  // CORRECCIÓN: Usar L.latLng() para garantizar el tipo correcto
  setHistorialRuta((prev) => {
    const newHistory = [...prev, L.latLng(latNum, lngNum)];
    return newHistory.length > 500 ? newHistory.slice(-500) : newHistory;
  });

  const posAnterior = taxiPosRef.current;
  const taxistaPos = taxistaAsignadoRef.current;

  const nuevoHeading = calcularHeading(
    posAnterior ? { lat: posAnterior.lat, lng: posAnterior.lng } : null,
    { lat: latNum, lng: lngNum },
    taxistaPos ? { lat: Number(taxistaPos.lat), lng: Number(taxistaPos.lng) } : null,
    estadoRef.current,
    posAnterior?.heading || 0
  );

  setTaxiPos({ lat: latNum, lng: lngNum, heading: nuevoHeading || 0 });

  if (estadoRef.current === "encurso") {
    setGeometriaRuta([L.latLng(latNum, lngNum)]);
  }
});

    // ACTUALIZACIÓN DE ESTADO DEL VIAJE
    socket.on("trip_status_update", (data: { estado: string; pasajeroEmail?: string }) => {
      const miEmail = userPositionRef.current?.email?.toLowerCase().trim();
      const emailRecibido = data.pasajeroEmail?.toLowerCase().trim();
      const nextEstado = String(data.estado || "").toLowerCase().trim();

      if (data.estado === "encurso" && (!emailRecibido || emailRecibido === miEmail)) {
        setSearchFlowActivo(false);
        setEstado(TRIP_STATES.ENCURSO);
        setChatAbierto(false);

        const taxiActual = taxiPosRef.current;
        if (taxiActual?.lat && taxiActual?.lng) {
          setHistorialRuta([[Number(taxiActual.lat), Number(taxiActual.lng)]]);
          setGeometriaRuta([L.latLng(Number(taxiActual.lat), Number(taxiActual.lng))]);
        }
        toast.success("¡Viaje iniciado! Que tengas un buen trayecto.");
      }

      // Escudo contra saltos accidentales
      if (["encurso", "finalizado"].includes(estadoRef.current) && nextEstado === "buscando") {
        console.warn("Ignorado salto a 'buscando' porque el viaje ya está cerrado o en curso.");
        return;
      }

      if (nextEstado === "buscando") {
        setSearchFlowActivo(true);
        setTaxistaAsignado(null);
        setTaxiPos(null);
        setEstado(TRIP_STATES.BUSCANDO);
        return;
      }

      if (["asignado", "encamino"].includes(nextEstado)) {
        setSearchFlowActivo(false);
        setEstado(nextEstado as ViajeEstado);
        return;
      }

      if (nextEstado === "finalizado") {
        if (!["asignado", "encamino", "encurso"].includes(estadoRef.current)) {
          return;
        }
        setSearchFlowActivo(false);
        setEstado(TRIP_STATES.PENDIENTE);
        setHistorialRuta([]);
        setTaxistaAsignado(null);
        setTaxiPos(null);
        setChatAbierto(false);
        setGeometriaRuta([]);
        toast.success("¡Viaje finalizado!");
      }
    });

    // VIAJE TERMINADO
    socket.on("trip_finished", (data: { pasajeroEmail: string }) => {
      const miEmail = userPositionRef.current?.email?.toLowerCase().trim();
      const emailRecibido = data.pasajeroEmail?.toLowerCase().trim();

      if (!["asignado", "encamino", "encurso"].includes(estadoRef.current)) {
        return;
      }

      if (emailRecibido === miEmail || !data.pasajeroEmail) {
        setSearchFlowActivo(false);
        setEstado(TRIP_STATES.PENDIENTE);
        setTaxistaAsignado(null);
        setTaxiPos(null);
        setHistorialRuta([]);
        setGeometriaRuta([]);
        setChatAbierto(false);
        toast.success("¡Viaje finalizado! Gracias por viajar con nosotros.", {
          position: "top-center",
          autoClose: 4000,
        });
      }
    });

    // TAXI RECHAZÓ LA SOLICITUD
    socket.on("taxi_rejected_request", () => {
      if (["asignado", "encamino", "encurso"].includes(estadoRef.current)) {
        console.warn("🛡️ taxi_rejected_request tardío ignorado: viaje ya confirmado.");
        return;
      }
      setSearchFlowActivo(true);
      setTaxistaAsignado(null);
      setTaxiPos(null);
      setEstado(TRIP_STATES.BUSCANDO);
      toast.info("Buscando otra unidad cercana...");
    });

    socket.on("no_taxis_available", (payload?: { message?: string }) => {
      if (["asignado", "encamino", "encurso"].includes(estadoRef.current)) {
        console.warn("🛡️ no_taxis_available tardío ignorado: viaje ya confirmado.");
        return;
      }
      setSearchFlowActivo(true);
      setTaxistaAsignado(null);
      setTaxiPos(null);
      setEstado(TRIP_STATES.BUSCANDO);
      if (payload?.message) {
        toast.info(payload.message, { autoClose: 2500 });
      }
    });

    socket.on("dispatch_error", (payload?: { message?: string }) => {
      if (["asignado", "encamino", "encurso"].includes(estadoRef.current)) {
        console.warn("🛡️ dispatch_error tardío ignorado: viaje ya confirmado.");
        return;
      }
      setSearchFlowActivo(true);
      setEstado(TRIP_STATES.BUSCANDO);
      if (payload?.message) {
        toast.warn(payload.message, { autoClose: 2500 });
      }
    });

    return () => {
      socket.off("taxi_moved");
      socket.off("update_trip_path");
      socket.off("response_from_taxi");
      socket.off("trip_status_update");
      socket.off("trip_finished");
      socket.off("taxi_rejected_request");
      socket.off("no_taxis_available");
      socket.off("dispatch_error");
    };
  }, [socket]); //  SOLO depende de socket - nunca se re-registra por cambios de posición

  // ============================================================
  //  HEARTBEAT OPTIMIZADO - No se re-crea en cada cambio de posición
  // ============================================================
  useEffect(() => {
    if (!userPosition?.email || !userPosition?.lat) return;

    const interval = setInterval(() => {
      // Candado: no enviar si está inactivo
      if (estadoRef.current === "pendiente" || estadoRef.current === "finalizado") return;
      
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
    setEstado(TRIP_STATES.BUSCANDO || ("buscando" as ViajeEstado));

    socket.emit("request_taxi", {
      email: userPosition.email.toLowerCase().trim(),
      name: userPosition.name,
      lat: userPosition.lat,
      lng: userPosition.lng,
      destinationLat,
      destinationLng,
      destinationAddress: destinationAddress || destinationQuery || undefined,
      role: "pasajero",
      estado: "buscando",
      timestamp: new Date().toISOString(),
    });

    toast.info("Buscando taxi disponible...", { autoClose: 3000 });
  }, [userPosition, estado, destinationLat, destinationLng, destinationAddress, destinationQuery]);

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
    setHistorialRuta([]);
    setGeometriaRuta([]);
    toast.info("Solicitud cancelada correctamente.");
  }, [userPosition?.email, taxistaAsignado?.email]);

  const resetearApp = useCallback(() => {
    setSearchFlowActivo(false);
    setEstado(TRIP_STATES.PENDIENTE);
    setTaxistaAsignado(null);
    setTaxiPos(null);
    setHistorialRuta([]);
    setGeometriaRuta([]);
    setChatAbierto(false);
    limpiarDestino();
  }, [limpiarDestino]);

  // ============================================================
  // RECORTE DE RUTA DINÁMICA (optimizado)
  // ============================================================
  useEffect(() => {
    if (!taxiPos?.lat || !taxiPos?.lng || geometriaRuta.length === 0) return;
    if (!["asignado", "encamino"].includes(estado)) return;

    const posTaxi = L.latLng(Number(taxiPos.lat), Number(taxiPos.lng));
    let indiceMasCercano = -1;
    let distanciaMinima = Infinity;

    geometriaRuta.forEach((punto: any, index: number) => {
      const pLeaflet = L.latLng(punto.lat ?? punto[0], punto.lng ?? punto[1]);
      const d = posTaxi.distanceTo(pLeaflet);
      if (d < distanciaMinima) {
        distanciaMinima = d;
        indiceMasCercano = index;
      }
    });

    if (distanciaMinima < 45 && indiceMasCercano > 0) {
      setGeometriaRuta((prev) => prev.slice(indiceMasCercano));
    } else if (distanciaMinima >= 45) {
      console.log("El taxista tomó otra calle. Recalculando polilínea...");
      setGeometriaRuta([]);
    }
  }, [taxiPos, estado, geometriaRuta.length]); //  Solo reaccionar al length, no al array completo

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
  const compactoInferior = ["buscando", "preasignado", "asignado", "encamino", "encurso"].includes(estado);
  const mostrarTextoBuscando = !taxistaAsignado && ["buscando", "preasignado"].includes(estado);

  useEffect(() => {
    setDestinoColapsado(enCaminoUI);
  }, [enCaminoUI]);

  return (
    <div className="h-dvh bg-slate-50 flex flex-col items-center font-sans relative overflow-hidden">
      <ToastContainer theme="light" />
      <div className="absolute top-0 left-0 w-full h-1 bg-[#22c55e] z-[2001]"></div>

      {/* MAIN */}
      <main className="w-full max-w-md bg-white rounded-t-[2.5rem] shadow-2xl overflow-hidden border border-slate-100 relative flex flex-col flex-1 min-h-0">
        <div className="absolute top-4 left-4 right-4 z-[1002] flex items-center justify-between pointer-events-none">
          <h1 className="text-sm font-black text-white tracking-tighter uppercase italic drop-shadow-[0_2px_8px_rgba(0,0,0,0.45)]">
            VALLES<span className="text-[#22c55e]">VIAJE</span>
          </h1>
          <div className="flex items-center gap-2 bg-white/95 px-3 py-1 rounded-full border border-slate-200 shadow-sm backdrop-blur-sm">
            <div
              className={`h-1.5 w-1.5 rounded-full ${
                userPosition?.lat ? "bg-[#22c55e]" : "bg-red-500 animate-pulse"
              }`}
            ></div>
            <span className="text-[8px] font-black text-slate-500 uppercase">GPS</span>
          </div>
        </div>

        <div className="absolute top-8 left-4 z-[1002]">
          <button
            onClick={handleLogout}
            className="bg-red-600 text-white px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest shadow-lg active:scale-95"
          >
            Salir
          </button>
        </div>

        {/* MAPA */}
        <div className="flex-1 min-h-[200px] w-full relative bg-slate-100">
          {userPosition?.lat && userPosition?.lng ? (
            <>
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

              {estado !== "encurso" && (
                <Marker
                  position={destinationPosition || [userPosition.lat, userPosition.lng]}
                  icon={destinationMarkerIcon}
                  draggable={true}
                  eventHandlers={{
                    dragend: (event) => {
                      const marker = event.target as L.Marker;
                      const next = marker.getLatLng();
                      void actualizarDestinoDesdeMarker(next.lat, next.lng);
                    },
                  }}
                >
                  <Popup>Destino (arrastra el pin)</Popup>
                </Marker>
              )}

              {destinationPosition && estado !== "encurso" && (
                <Polyline
                  positions={[[userPosition.lat, userPosition.lng], destinationPosition]}
                  pathOptions={{
                    color: "#22c55e",
                    weight: 3,
                    opacity: 0.75,
                    dashArray: "6 8",
                  }}
                />
              )}

              {taxiPos && ["asignado", "encamino", "encurso"].includes(estado) && (
                <RotatedMarker
                  position={[taxiPos.lat, taxiPos.lng]}
                  icon={taxistaIcon}
                  rotationAngle={taxiPos.heading || 0}
                >
                  <Popup>Unidad {taxistaAsignado?.taxiNumber}</Popup>
                </RotatedMarker>
              )}

              {/* LÍNEA 1: Ruta de aproximación */}
              {["asignado", "encamino"].includes(estado) && geometriaRuta.length > 0 && (
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

              {/* CONTROL DE ENRUTAMIENTO */}
              {taxiPos?.lat &&
                taxiPos?.lng &&
                userPosition?.lat &&
                userPosition?.lng &&
                ["asignado", "encamino"].includes(estado) &&
                geometriaRuta.length === 0 && (
                  <Suspense fallback={null}>
                    <RoutingMachine
                      waypoints={[
                        L.latLng(Number(taxiPos.lat), Number(taxiPos.lng)),
                        L.latLng(Number(userPosition.lat), Number(userPosition.lng)),
                      ]}
                      onRouteFound={(coords: L.LatLng[]) => {
                        console.log("­ƒù║´©Å Nueva trayectoria trazada. Puntos:", coords.length);
                        setGeometriaRuta(coords);
                      }}
                    />
                  </Suspense>
                )}

              {/* LÍNEA 2: Rastro del viaje */}
              {estado === "encurso" && historialRuta.length > 0 && (
                <Polyline
                  positions={historialRuta}
                  pathOptions={{ color: "#22c55e", weight: 4, lineJoin: "round" }}
                />
              )}

              {/* LÍNEA 3: Rumbo al destino */}
              {estado === "encurso" && geometriaRuta.length > 0 && (
                <Polyline
                  positions={geometriaRuta}
                  pathOptions={{ color: "#22c55e", weight: 4, lineJoin: "round" }}
                />
              )}
            </MapContainer>

            {!destinoColapsado && (
            <div className="absolute left-3 right-3 bottom-1 z-[1100] bg-white/95 backdrop-blur-md border border-slate-200 rounded-2xl shadow-2xl p-3 transition-all duration-300 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-400">Destino</p>
                  <p className="text-[10px] font-bold text-slate-700 truncate max-w-[220px]">
                    {destinationAddress || "Elige una dirección o mueve el pin"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {enCaminoUI && (
                    <button
                      type="button"
                      onClick={() => setDestinoColapsado(true)}
                      className="text-[8px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-700"
                    >
                      Colapsar
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={limpiarDestino}
                    className="text-[8px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-700"
                  >
                    Limpiar
                  </button>
                </div>
              </div>

              <div className="flex gap-2">
                <input
                  value={destinationQuery}
                  onChange={(e) => setDestinationQuery(e.target.value)}
                  placeholder="Escribe tu destino"
                  className="flex-1 min-w-0 bg-slate-100 border border-slate-200 rounded-xl px-3 py-3 text-sm font-medium text-slate-800 outline-none focus:ring-2 focus:ring-[#22c55e]/30 disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => void geocodificarDestino(destinationQuery)}
                  disabled={isSearchingDestination || !destinationQuery.trim()}
                  className="px-4 rounded-xl bg-[#22c55e] text-[#0f172a] font-black text-[9px] uppercase tracking-widest disabled:opacity-60 active:scale-95"
                >
                  {isSearchingDestination ? "..." : "Buscar"}
                </button>
              </div>

              <p className="text-[8px] font-bold text-slate-400 uppercase tracking-[0.18em]">
                Arrastra el pin verde para ajustar la ubicación exacta.
              </p>
            </div>
            )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-400 font-black text-[10px] uppercase tracking-widest animate-pulse">
              Buscando tu ubicación...
            </div>
          )}
        </div>

        {/* Badge de estado */}
        <div className="absolute top-12 right-4 z-[1000]">
          <div
            className={`px-4 py-2 rounded-2xl text-[9px] font-black uppercase tracking-widest flex items-center gap-2 shadow-lg transition-all duration-500 ${
              estado === "encurso"
                ? "bg-slate-800/80 text-slate-100 backdrop-blur-md"
                : estado === "buscando"
                ? "bg-amber-500 text-white animate-pulse"
                : "bg-[#22c55e] text-white animate-pulse"
            }`}
          >
            {obtenerTextoEstado()}
          </div>
        </div>

        {/* CARD DEL TAXISTA */}
        {taxistaAsignado && (
          <div className={`mx-5 ${enCaminoUI ? "mt-8" : "mt-5"} relative z-[1001] ${compactoInferior ? "p-2.5" : "p-3"} bg-white border border-slate-100 rounded-[1.4rem] flex items-center ${compactoInferior ? "gap-3" : "gap-4"} shadow-xl transition-all duration-300`}>
            <div className={`${compactoInferior ? "h-8 w-8 text-base" : "h-10 w-10 text-lg"} bg-green-50 rounded-xl flex items-center justify-center`}>
              🚖
            </div>
            <div className="flex-1 flex items-baseline gap-2">
              <p className={`${compactoInferior ? "text-[12px]" : "text-[14px]"} font-black text-slate-800 leading-tight`}>
                {taxistaAsignado.name}
              </p>
              <p className={`${compactoInferior ? "text-[13px]" : "text-[16px]"} font-black text-[#22c55e] whitespace-nowrap`}>
                Taxi {taxistaAsignado.taxiNumber || "ECO"}
              </p>
            </div>
          </div>
        )}

        {/* BOTONES */}
        <div className={`${compactoInferior ? "px-4 pt-4 pb-14" : "px-5 pt-5 pb-16"} flex flex-col shrink-0 bg-white transition-all duration-300`}>
          {enCaminoUI && destinoColapsado && (
            <div className={`${compactoInferior ? "mb-2 p-2.5" : "mb-3 p-3"} rounded-2xl border border-slate-200 bg-slate-50`}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className={`${compactoInferior ? "text-[7px]" : "text-[8px]"} font-black uppercase tracking-[0.2em] text-slate-400 mb-1`}>Destino</p>
                  <p className={`${compactoInferior ? "text-[9px]" : "text-[10px]"} font-bold text-slate-700 truncate`}>
                    {destinationAddress || "Sin destino especificado"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDestinoColapsado(false)}
                  className="text-[8px] font-black uppercase tracking-widest text-[#22c55e]"
                >
                  Expandir
                </button>
              </div>
            </div>
          )}

          <div className={`${compactoInferior ? "mb-2" : "mb-3"}`}>
            <p className={`${compactoInferior ? "text-[7px]" : "text-[8px]"} font-black text-slate-400 uppercase tracking-[0.2em] mb-1`}>
              Servicio Valles
            </p>
            <h2 className={`${compactoInferior ? "text-base" : "text-lg"} font-black text-slate-900 tracking-tighter leading-tight`}>
              {estado === "pendiente" && "A donde vamos hoy?"}
              {estado === "buscando" && "Buscando unidad..."}
              {["asignado", "encamino"].includes(estado) && "Tu taxi viene en camino"}
              {estado === "encurso" && "Buen viaje por Valles!"}
            </h2>
          </div>

          <div className={`${compactoInferior ? "space-y-2 pt-1" : "space-y-3 pt-2"}`}>
            {estado === "pendiente" && !searchFlowActivo && (
              <button
                onClick={solicitarTaxi}
                className={`${compactoInferior ? "py-4 text-[11px]" : "py-5 text-xs"} w-full rounded-[1.2rem] font-black transition-all transform active:scale-95 shadow-xl tracking-widest bg-[#22c55e] text-white shadow-green-900/20 hover:bg-[#16a34a]`}
              >
                SOLICITAR TRANSPORTE
              </button>
            )}

            {(searchFlowActivo || ["buscando", "preasignado", "asignado", "encamino"].includes(estado)) && (
              <button
                onClick={cancelarSolicitud}
                className={`${compactoInferior ? "py-2.5 text-[9px]" : "py-3 text-[8px]"} w-full bg-red-50 text-red-500 rounded-[1.2rem] font-bold uppercase border border-red-100 active:bg-red-100`}
              >
                Cancelar Solicitud
              </button>
            )}

            {mostrarTextoBuscando && (
              <p className="text-center text-[10px] font-black uppercase tracking-[0.16em] text-amber-500 animate-pulse">
                Buscando otra unidad...
              </p>
            )}

            {(taxistaAsignado && ["asignado", "encamino"].includes(estado)) && (
              <p className="text-center text-[10px] font-black uppercase tracking-[0.16em] text-[#22c55e]">
                Unidad confirmada, en camino
              </p>
            )}
          </div>
        </div>
      </main>

      {/* CHAT FLOTANTE */}
      {taxistaAsignado?.email && ["asignado", "encamino"].includes(estado) && (
        <>
          <div
            className={`fixed z-[2000] bottom-24 ${chatPanelOnLeft ? "left-3 sm:left-4" : "right-3 sm:right-4"} left-3 sm:left-auto sm:w-[340px] bg-white border border-slate-100 rounded-2xl shadow-2xl overflow-hidden transition-opacity duration-150 ${
              chatAbierto ? "opacity-100 visible" : "opacity-0 invisible pointer-events-none"
            }`}
          >
            <div className="h-11 px-4 flex items-center justify-between bg-white border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
                <span className="text-[10px] font-black text-slate-800 uppercase tracking-widest">Chat con Unidad</span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setChatAbierto(false)}
                  className="text-slate-500 hover:text-slate-800 text-xs font-black uppercase tracking-widest"
                >
                  Minimizar
                </button>
                <button
                  onClick={() => setChatAbierto(false)}
                  className="text-slate-500 hover:text-slate-800 text-sm font-black"
                  aria-label="Cerrar chat"
                >
                  x
                </button>
              </div>
            </div>
            <div className="h-[280px] bg-white">
              <ChatBox
                toEmail={taxistaAsignado.email || (taxistaAsignado as any).taxistaEmail || ""}
                userName={userPosition?.name || "Pasajero"}
              />
            </div>
          </div>

          {!chatAbierto && (
            <button
              onPointerDown={handleChatBubblePointerDown}
              onPointerMove={handleChatBubblePointerMove}
              onPointerUp={finishChatBubbleDrag}
              onPointerCancel={finishChatBubbleDrag}
              style={{ left: `${chatBubbleX ?? CHAT_BUBBLE_MARGIN}px` }}
              className="fixed z-[2000] bottom-24 h-[52px] w-[52px] bg-[#22c55e] text-white rounded-full border-b-4 border-[#15803d] shadow-2xl font-black text-lg flex items-center justify-center active:translate-y-1 select-none"
              title="Chat con unidad"
              aria-label="Abrir chat con unidad"
              data-dragging={isDraggingChatBubble ? "true" : "false"}
            >
              💬
            </button>
          )}
        </>
      )}

      {/* PANTALLA DE FINALIZACIÓN */}
      {estado === "finalizado" && (
        <div className="fixed inset-0 z-[3000] bg-[#22c55e] flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in">
          <div className="bg-white rounded-[2.5rem] p-8 shadow-2xl flex flex-col items-center text-center max-w-xs w-full">
            <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center text-3xl mb-4">
              ✓
            </div>
            <div className="text-2xl font-black text-slate-800 tracking-tighter mb-4 uppercase leading-tight">
              ¡Gracias por viajar con nosotros!
            </div>
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
