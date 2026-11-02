// src/context/TravelContext.tsx
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { jwtDecode, JwtPayload } from "jwt-decode";
import { Position, Destination, Rol } from "../types/Positions";
import { socket, connectSocket } from "../lib/socket";
import axiosInstance from "../lib/axiosConfig";

interface ScreenWakeLock {
  release: () => Promise<void>;
  released?: boolean;
  addEventListener?: (type: "release", listener: () => void) => void;
}

interface TravelContextType {
  userPosition: Position | null;
  setUserPosition: (pos: Position | null) => void;
  destination: Destination | null;
  setDestination: (dest: Destination | null) => void;
  isTripActive: boolean;
  setIsTripActive: (active: boolean) => void;
  taxistasActivos: Position[];
  setTaxistasActivos: (taxistas: Position[]) => void;
  pasajerosActivos: Position[];
  setPasajerosActivos: (pasajeros: Position[]) => void;
  taxiPos: { lat: number; lng: number; heading?: number; taxiNumber?: string } | null;
  setTaxiPos: React.Dispatch<React.SetStateAction<{ lat: number; lng: number; heading?: number; taxiNumber?: string } | null>>;
  logout: () => void;
}

interface DecodedToken extends JwtPayload {
  email: string;
  role: Rol;
  name?: string;
  phone?: string;
  taxiNumber?: string;
}

const TravelContext = createContext<TravelContextType | undefined>(undefined);

const restoreSessionFromStorage = (): Position | null => {
  const token = localStorage.getItem("token");
  if (!token) return null;

  try {
    const decoded = jwtDecode<DecodedToken>(token);
    if (decoded.exp && Date.now() >= decoded.exp * 1000) {
      localStorage.removeItem("token");
      return null;
    }
    const storedRole = (localStorage.getItem("role") as Rol | null) || decoded.role;
    const storedEmail = localStorage.getItem("email") || decoded.email;
    const storedName = localStorage.getItem("userName") || decoded.name || "Usuario";
    const storedPhone = localStorage.getItem("phone") || decoded.phone;
    const storedTaxiNumber = localStorage.getItem("taxiNumber") || decoded.taxiNumber;

    socket.auth = {
      email: storedEmail,
      token,
      role: storedRole,
    };

    return {
      email: storedEmail,
      name: storedName,
      phone: storedPhone || undefined,
      lat: null,
      lng: null,
      role: storedRole,
      taxiNumber: storedRole === "taxista" ? storedTaxiNumber || undefined : undefined,
    };
  } catch (err) {
    console.error("❌ Error restaurando sesión desde storage:", err);
    return null;
  }
};

const keepSessionAlive = async () => {

  console.log("🟣 keepSessionAlive() llamado", {
    connected: socket.connected,
    active: socket.active,
    socketId: socket.id,
  });
  
  const token = localStorage.getItem("token");
  const email = localStorage.getItem("email");
  const role = localStorage.getItem("role") as Rol | null;

  if (!token || !email || !role) {
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  socket.auth = {
    ...(typeof socket.auth === "object" && socket.auth ? socket.auth : {}),
    token,
    email: normalizedEmail,
    role,
  };

  if (!navigator.onLine) {
    return;
  }

  try {
    await axiosInstance.get("/api/auth/heartbeat");
  } catch (error: any) {
    const status = error?.response?.status;
    const message = String(error?.response?.data?.message || "").toLowerCase();
    const isTokenIssue = status === 401 || (status === 403 && (
      message.includes("token expirado") ||
      message.includes("token inválido") ||
      message.includes("token no proporcionado")
    ));

    if (!isTokenIssue) {
      return;
    }

    localStorage.removeItem("token");
    localStorage.removeItem("email");
    localStorage.removeItem("role");
    localStorage.removeItem("userName");
    localStorage.removeItem("phone");
    localStorage.removeItem("taxiNumber");
    window.location.href = "/login";
    return;
  }

  if (!socket.connected && !socket.active) {
    connectSocket(normalizedEmail, role);
  }
};

export const TravelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 🚀 INICIALIZACIÓN SÍNCRONA: Recupera sesión y conecta Socket antes del primer render
  const [userPosition, setUserPosition] = useState<Position | null>(() => restoreSessionFromStorage());

  const [destination, setDestination] = useState<Destination | null>(null);
  const [isTripActive, setIsTripActive] = useState(false);
  const [taxistasActivos, setTaxistasActivos] = useState<Position[]>([]);
  const [pasajerosActivos, setPasajerosActivos] = useState<Position[]>([]);
  const [taxiPos, setTaxiPos] = useState<{ lat: number; lng: number; heading?: number; taxiNumber?: string } | null>(null);
  const wakeLockRef = useRef<ScreenWakeLock | null>(null);

  const tryRequestWakeLock = useCallback(async () => {
    const wakeLockNavigator = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<ScreenWakeLock> };
    };

    if (!wakeLockNavigator.wakeLock || !userPosition?.email) {
      return;
    }

    try {
      if (document.hidden) return;

      /**
       * El navegador libera el wake lock por su cuenta al ocultar la pestaña,
       * pero la referencia seguía "viva" y por eso no se volvía a pedir nunca:
       * el móvil dormía la app y el socket moría por `ping timeout`.
       */
      const sentinelActual = wakeLockRef.current;

      if (sentinelActual && !sentinelActual.released) {
        return;
      }

      const sentinel = await wakeLockNavigator.wakeLock.request("screen");

      wakeLockRef.current = sentinel;

      sentinel.addEventListener?.("release", () => {
        wakeLockRef.current = null;
      });
    } catch (error) {
      console.debug("⚠️ Wake Lock no disponible en esta vista:", error);
    }
  }, [userPosition?.email]);

  const releaseWakeLock = useCallback(async () => {
    if (!wakeLockRef.current) return;

    try {
      await wakeLockRef.current.release();
    } catch (error) {
      console.debug("⚠️ No se pudo liberar Wake Lock:", error);
    } finally {
      wakeLockRef.current = null;
    }
  }, []);

  // 🧠 Reflejo del estado más reciente para callbacks estables.
  // Sin esto, `userPosition`/`taxiPos` cambiaban en cada tick de GPS y
  // re-creaban los efectos de abajo (ver comentarios en cada uno).
  const userPositionRef = useRef(userPosition);
  const taxiPosRef = useRef(taxiPos);

  useEffect(() => {
    userPositionRef.current = userPosition;
  }, [userPosition]);

  useEffect(() => {
    taxiPosRef.current = taxiPos;
  }, [taxiPos]);

  // 🔒 Pedir el bloqueo de pantalla en cuanto hay sesión (antes sólo se pedía al
  // volver a primer plano, así que una app abierta y nunca enfocada de nuevo se
  // quedaba con la pantalla libre para dormirse).
  useEffect(() => {
    if (!userPosition?.email) return;

    void tryRequestWakeLock();
  }, [userPosition?.email, tryRequestWakeLock]);

  const reconnectIfNeeded = useCallback(() => {

    const posicionActual = userPositionRef.current;
    const taxiActual = taxiPosRef.current;

    const email = posicionActual?.email || localStorage.getItem("email");
    const role = posicionActual?.role || (localStorage.getItem("role") as Rol | null);
    const token = localStorage.getItem("token");

    if (!email || !role) return;

    const activeSession = posicionActual || restoreSessionFromStorage();
    if (!activeSession) return;

    if (token) {
      socket.auth = {
        ...(typeof socket.auth === "object" && socket.auth ? socket.auth : {}),
        token,
        email: email.toLowerCase().trim(),
        role,
      };
    }

    if (!socket.connected && !socket.active) {
      connectSocket(email.toLowerCase().trim(), role);
    } else if (socket.connected) {
      socket.emit("reproducir_estado_viaje", { email: email.toLowerCase().trim(), role });
    }

    // 📍 Reanunciar la posición propia tras reconectar.
    // `taxiPos` es la posición del TAXISTA que el cliente está siguiendo: sólo
    // tiene sentido para un taxista. Un pasajero debe publicar su propio GPS
    // (`activeSession`); antes publicaba las coordenadas del taxi como si
    // fueran suyas y corrompía su punto de recogida en la BD.
    const esTaxista = role === "taxista";

    const latPublicar = esTaxista ? taxiActual?.lat : activeSession.lat;
    const lngPublicar = esTaxista ? taxiActual?.lng : activeSession.lng;

    if (latPublicar && lngPublicar && socket.connected) {
      socket.emit("position", {
        ...activeSession,
        lat: Number(latPublicar),
        lng: Number(lngPublicar),
      });
    }
  }, []); // 🎯 Identidad estable: se lee el estado desde refs

 useEffect(() => {
  const email = userPosition?.email || localStorage.getItem("email");
  const role = userPosition?.role || (localStorage.getItem("role") as Rol | null);

  if (!email || !role) return;

  console.log("🔵 CONEXIÓN INICIAL TravelContext", {
    email,
    role,
  });

  connectSocket(email, role);
}, [userPosition?.email, userPosition?.role]);

  // 🛰️ EFECTO "DESPERTADOR": Revive la app cuando el usuario regresa tras mucho tiempo
  //
  // ⚠️ Este efecto NO debe depender de `userPosition`: antes lo hacía y, como la
  // posición cambia en cada tick de GPS, se desmontaba cada pocos segundos y su
  // limpieza llamaba a `releaseWakeLock()`. Resultado: el bloqueo de pantalla se
  // liberaba continuamente, el móvil dormía la app durante el viaje y el socket
  // moría por `ping timeout` (el taxista dejaba de enviar coordenadas).
  useEffect(() => {
    const handleResume = async () => {
      if (document.visibilityState !== "visible" && navigator.onLine === false) return;

      const restoredSession = restoreSessionFromStorage();
      if (!userPositionRef.current && restoredSession) {
        console.log("🔄 Restaurando sesión local tras volver del segundo plano...");
        setUserPosition(restoredSession);
      }

      if (userPositionRef.current || restoredSession) {
        console.log("☀️ Valles Conecta: Validando conexión en primer plano...");
        await keepSessionAlive();
        await tryRequestWakeLock();
        reconnectIfNeeded();
      }
    };

    const handleOnline = () => {
      void tryRequestWakeLock();
      reconnectIfNeeded();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void keepSessionAlive();
        void tryRequestWakeLock();
        reconnectIfNeeded();
      } else {
        void releaseWakeLock();
      }
    };

    // Si la pestaña se cierra de verdad (no bfcache), cortamos el socket para no dejarlo vivo en segundo plano
    const handlePageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        socket.disconnect();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleResume);
    window.addEventListener("online", handleOnline);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleResume);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("pagehide", handlePageHide);
      void releaseWakeLock();
    };
  }, [keepSessionAlive, reconnectIfNeeded, releaseWakeLock, tryRequestWakeLock]);

  // 💓 LATIDO DE SESIÓN (cada 60 s)
  //
  // ⚠️ Antes dependía de `userPosition`/`reconnectIfNeeded`, que cambian en cada
  // tick de GPS, así que el intervalo se reiniciaba antes de cumplirse y NUNCA
  // llegaba a ejecutarse: `reproducir_estado_viaje` (la resincronización del
  // viaje) y `keepSessionAlive()` quedaban muertos. Ahora sólo depende de la
  // existencia de sesión.
  const hasSession = Boolean(userPosition?.email || localStorage.getItem("email"));

  useEffect(() => {
    if (!hasSession) return;

    const intervalId = window.setInterval(() => {
      const token = localStorage.getItem("token");
      const email = localStorage.getItem("email");
      const role = localStorage.getItem("role") as Rol | null;

      if (!token || !email || !role) {
        return;
      }

      void keepSessionAlive();

      if (document.visibilityState === "visible" && navigator.onLine && !socket.connected) {
        reconnectIfNeeded();
      }

      if (socket.connected) {
        // Resincroniza el estado del viaje activo (el backend lo reproduce).
        socket.emit("reproducir_estado_viaje", {
          email: email.toLowerCase().trim(),
          role,
        });
      }
    }, 60000);

    return () => window.clearInterval(intervalId);
  }, [keepSessionAlive, reconnectIfNeeded, hasSession]);


  // 🚪 CIERRE DE SESIÓN LIMPIO
  const logout = () => {
    socket.disconnect();
    localStorage.removeItem("token");
    localStorage.removeItem("email");
    localStorage.removeItem("role");
    localStorage.removeItem("userName");
    localStorage.removeItem("phone");
    localStorage.removeItem("taxiNumber");
    setUserPosition(null);
    setDestination(null);
    setIsTripActive(false);
    setTaxistasActivos([]);
    setPasajerosActivos([]);
    window.location.href = "/login";
  };


  return (
    <TravelContext.Provider
      value={{
        userPosition,
        setUserPosition,
        destination,
        setDestination,
        isTripActive,
        setIsTripActive,
        taxistasActivos,
        setTaxistasActivos,
        pasajerosActivos,
        setPasajerosActivos,
        logout,
        taxiPos,
        setTaxiPos,
      }}
    >
      {children}
    </TravelContext.Provider>
  );
};


export const useTravel = (): TravelContextType => {
  const context = useContext(TravelContext);
  if (!context) {
    throw new Error("useTravel must be used within a TravelProvider");
  }
  return context;
};

