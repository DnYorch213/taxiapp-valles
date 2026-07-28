// src/context/TravelContext.tsx
import React, { createContext, useContext, useState, useEffect } from "react";
import { jwtDecode, JwtPayload } from "jwt-decode";
import { Position, Destination, Rol } from "../types/Positions";
import { socket, connectSocket } from "../lib/socket"; // 🚨 Importación crucial para la persistencia

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

export const TravelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 🚀 INICIALIZACIÓN SÍNCRONA: Recupera sesión y conecta Socket antes del primer render
  const [userPosition, setUserPosition] = useState<Position | null>(() => restoreSessionFromStorage());

  const [destination, setDestination] = useState<Destination | null>(null);
  const [isTripActive, setIsTripActive] = useState(false);
  const [taxistasActivos, setTaxistasActivos] = useState<Position[]>([]);
  const [pasajerosActivos, setPasajerosActivos] = useState<Position[]>([]);
  const [taxiPos, setTaxiPos] = useState<{ lat: number; lng: number; heading?: number; taxiNumber?: string } | null>(null);

  useEffect(() => {
    const email = userPosition?.email || localStorage.getItem("email");
    const role = userPosition?.role || (localStorage.getItem("role") as Rol | null);

    if (!email || !role) return;

    connectSocket(email, role);
  }, [userPosition?.email, userPosition?.role]);

  // 🛰️ EFECTO "DESPERTADOR": Revive la app cuando el usuario regresa tras mucho tiempo
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;

      const restoredSession = restoreSessionFromStorage();
      if (!userPosition && restoredSession) {
        console.log("🔄 Restaurando sesión local tras volver del segundo plano...");
        setUserPosition(restoredSession);
      }

      // Si la app vuelve a primer plano (visible) y tenemos un usuario logueado
      if (userPosition || restoredSession) {
        const activeSession = userPosition || restoredSession;
        console.log("☀️ Valles Conecta: Validando conexión en primer plano...");
        
        // 1. Forzar reconexión si el sistema operativo mató el socket
        if (!socket.connected) {
          const token = localStorage.getItem("token");
          socket.auth = { ...socket.auth, token };
          connectSocket(activeSession!.email, activeSession!.role);
        }

    // 2. Reportar posición de inmediato si ya tenemos coordenadas reales (taxiPos)
    if (taxiPos?.lat && taxiPos?.lng) {
      socket.emit("position", {
        ...activeSession, // identidad
        lat: taxiPos.lat,
        lng: taxiPos.lng
      });
    }
      }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
}, 
[userPosition, taxiPos]);


  // 🚪 CIERRE DE SESIÓN LIMPIO
  const logout = () => {
    socket.disconnect(); // 🚨 Cortamos el flujo de datos primero
    localStorage.clear();
    setUserPosition(null);
    setDestination(null);
    setIsTripActive(false);
    setTaxistasActivos([]);
    setPasajerosActivos([]);
    window.location.href = "/login"; // Limpieza total de estados de navegación
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

