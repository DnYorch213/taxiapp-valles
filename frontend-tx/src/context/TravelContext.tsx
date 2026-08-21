// src/context/TravelContext.tsx
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { jwtDecode, JwtPayload } from "jwt-decode";
import { Position, Destination, Rol } from "../types/Positions";
import { socket, connectSocket } from "../lib/socket";
import axiosInstance from "../lib/axiosConfig";

interface ScreenWakeLock { release: () => Promise<void>; }

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
  setTaxiPos: React.Dispatch<React.SetStateAction<{ lat: number; lng: number; heading?: number; taxiNumber?: string } | null>>;  logout: () => void;
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
      if (!document.hidden && !wakeLockRef.current) {
        wakeLockRef.current = await wakeLockNavigator.wakeLock.request("screen");
      }
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

  const reconnectIfNeeded = useCallback(() => {
    const email = userPosition?.email || localStorage.getItem("email");
    const role = userPosition?.role || (localStorage.getItem("role") as Rol | null);
    const token = localStorage.getItem("token");

    if (!email || !role) return;

    const activeSession = userPosition || restoreSessionFromStorage();
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

    if (taxiPos?.lat && taxiPos?.lng && socket.connected) {
      socket.emit("position", {
        ...activeSession,
        lat: taxiPos.lat,
        lng: taxiPos.lng,
      });
    }
  }, [taxiPos?.lat, taxiPos?.lng, userPosition]);

  useEffect(() => {
    const email = userPosition?.email || localStorage.getItem("email");
    const role = userPosition?.role || (localStorage.getItem("role") as Rol | null);

    if (!email || !role) return;

    connectSocket(email, role);
  }, [userPosition?.email, userPosition?.role]);

  // 🛰️ EFECTO "DESPERTADOR": Revive la app cuando el usuario regresa tras mucho tiempo
  useEffect(() => {
    const handleResume = async () => {
      if (document.visibilityState !== "visible" && navigator.onLine === false) return;

      const restoredSession = restoreSessionFromStorage();
      if (!userPosition && restoredSession) {
        console.log("🔄 Restaurando sesión local tras volver del segundo plano...");
        setUserPosition(restoredSession);
      }

      if (userPosition || restoredSession) {
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
  }, [keepSessionAlive, reconnectIfNeeded, releaseWakeLock, tryRequestWakeLock, userPosition]);

  useEffect(() => {
    if (!userPosition) return;

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
        socket.emit("reproducir_estado_viaje", {
          email: email.toLowerCase().trim(),
          role,
        });
      }
    }, 60000);

    return () => window.clearInterval(intervalId);
  }, [keepSessionAlive, reconnectIfNeeded, userPosition]);


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

