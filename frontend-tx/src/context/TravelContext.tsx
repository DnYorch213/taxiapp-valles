// src/context/TravelContext.tsx
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { Position, Destination, Rol } from "../types/Positions";
import { socket, connectSocket } from "../lib/socket";

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

const TravelContext = createContext<TravelContextType | undefined>(undefined);

const restoreSessionFromStorage = (): Position | null => {
  const storedEmail = localStorage.getItem("email");
  const storedRole = localStorage.getItem("role") as Rol | null;
  if (!storedEmail || !storedRole) return null;

  try {
    const storedName = localStorage.getItem("userName") || "Usuario";
    const storedPhone = localStorage.getItem("phone") || undefined;
    const storedTaxiNumber = localStorage.getItem("taxiNumber") || undefined;

    socket.auth = {
      email: storedEmail,
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
    console.error("? Error restaurando sesi?n desde storage:", err);
    return null;
  }
};

export const TravelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [userPosition, setUserPosition] = useState<Position | null>(() => restoreSessionFromStorage());

  const [destination, setDestination] = useState<Destination | null>(null);
  const [isTripActive, setIsTripActive] = useState(false);
  const [taxistasActivos, setTaxistasActivos] = useState<Position[]>([]);
  const [pasajerosActivos, setPasajerosActivos] = useState<Position[]>([]);
  const [taxiPos, setTaxiPos] = useState<{ lat: number; lng: number; heading?: number; taxiNumber?: string } | null>(null);

  const reconnectIfNeeded = useCallback(() => {
    const email = userPosition?.email || localStorage.getItem("email");
    const role = userPosition?.role || (localStorage.getItem("role") as Rol | null);

    if (!email || !role) return;

    const activeSession = userPosition || restoreSessionFromStorage();
    if (!activeSession) return;

    socket.auth = { email, role };

    if (!socket.connected && !socket.active) {
      connectSocket(email, role);
    } else if (socket.connected) {
      socket.emit("reproducir_estado_viaje", { email, role });
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

  useEffect(() => {
    const handleResume = () => {
      if (document.visibilityState !== "visible" && navigator.onLine === false) return;

      const restoredSession = restoreSessionFromStorage();
      if (!userPosition && restoredSession) {
        console.log("?? Restaurando sesi?n local tras volver del segundo plano...");
        setUserPosition(restoredSession);
      }

      if (userPosition || restoredSession) {
        console.log("?? Valles Conecta: Validando conexi?n en primer plano...");
        reconnectIfNeeded();
      }
    };

    const handleOnline = () => {
      reconnectIfNeeded();
    };

    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleResume);
    window.addEventListener("online", handleOnline);

    return () => {
      document.removeEventListener("visibilitychange", handleResume);
      window.removeEventListener("focus", handleResume);
      window.removeEventListener("online", handleOnline);
    };
  }, [reconnectIfNeeded, userPosition]);

  useEffect(() => {
    if (!userPosition) return;

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine && !socket.connected) {
        reconnectIfNeeded();
      }
    }, 30000);

    return () => window.clearInterval(intervalId);
  }, [reconnectIfNeeded, userPosition]);

  const logout = () => {
    socket.disconnect();
    localStorage.clear();
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
