// src/context/TravelContext.tsx
import React, { createContext, useContext, useState, useEffect } from "react";
import { jwtDecode, JwtPayload } from "jwt-decode";
import { Position, Destination, Rol } from "../types/Positions";
import { socket } from "../lib/socket"; // 🚨 Importación crucial para la persistencia

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
  logout: () => void;
}

interface DecodedToken extends JwtPayload {
  email: string;
  role: Rol;
  name?: string;
  taxiNumber?: string;
}

const TravelContext = createContext<TravelContextType | undefined>(undefined);

export const TravelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 🚀 INICIALIZACIÓN SÍNCRONA: Recupera sesión y conecta Socket antes del primer render
  const [userPosition, setUserPosition] = useState<Position | null>(() => {
    const token = localStorage.getItem("token");
    if (token) {
      try {
        const decoded = jwtDecode<DecodedToken>(token);
        
        // 🛡️ RE-CONEXIÓN INMEDIATA: Evita que el socket inicie vacío
        socket.auth = { 
          email: decoded.email, 
          token: token, 
          role: decoded.role 
        };
        
        if (!socket.connected) socket.connect();

        return {
          email: decoded.email,
          name: decoded.name || "Usuario",
          lat: 0,
          lng: 0,
          role: decoded.role,
          taxiNumber: decoded.role === "taxista" ? decoded.taxiNumber : undefined,
        };
      } catch (err) {
        console.error("❌ Error decodificando token inicial:", err);
        return null;
      }
    }
    return null;
  });

  const [destination, setDestination] = useState<Destination | null>(null);
  const [isTripActive, setIsTripActive] = useState(false);
  const [taxistasActivos, setTaxistasActivos] = useState<Position[]>([]);
  const [pasajerosActivos, setPasajerosActivos] = useState<Position[]>([]);

  // 🛰️ EFECTO "DESPERTADOR": Revive la app cuando el usuario regresa tras mucho tiempo
  useEffect(() => {
    const handleVisibilityChange = () => {
      // Si la app vuelve a primer plano (visible) y tenemos un usuario logueado
      if (document.visibilityState === "visible" && userPosition) {
        console.log("☀️ Valles Conecta: Validando conexión en primer plano...");
        
        // 1. Forzar reconexión si el sistema operativo mató el socket
        if (!socket.connected) {
          const token = localStorage.getItem("token");
          socket.auth = { ...socket.auth, token };
          socket.connect();
        }

        // 2. Reportar posición de inmediato si ya tenemos coordenadas
        if (userPosition.lat !== 0 && userPosition.lng !== 0) {
          socket.emit("position", userPosition);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [userPosition]);

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