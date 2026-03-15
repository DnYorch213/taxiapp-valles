// src/context/TravelContext.tsx
import React, { createContext, useContext, useState, useEffect } from "react";
import { jwtDecode, JwtPayload } from "jwt-decode";
import { Position, Destination, Rol } from "../types/Positions";

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
  // 🚀 CAMBIO CLAVE: Inicialización síncrona para evitar el delay del useEffect
  const [userPosition, setUserPosition] = useState<Position | null>(() => {
    const token = localStorage.getItem("token");
    if (token) {
      try {
        const decoded = jwtDecode<DecodedToken>(token);
        return {
          email: decoded.email,
          name: decoded.name || "Cargando...",
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

  // Mantenemos el useEffect por seguridad si el token cambia externamente, 
  // pero ya no es el encargado principal de la carga inicial.
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token && !userPosition) {
      try {
        const decoded = jwtDecode<DecodedToken>(token);
        setUserPosition({
          email: decoded.email,
          name: decoded.name || decoded.email,
          lat: 0,
          lng: 0,
          role: decoded.role,
          taxiNumber: decoded.role === "taxista" ? decoded.taxiNumber : undefined,
        });
      } catch (err) {
        console.error("Error en sincronización de token:", err);
      }
    }
  }, [userPosition]);

  const logout = () => {
    localStorage.clear(); // Limpia todo de una vez
    setUserPosition(null);
    setDestination(null);
    setIsTripActive(false);
    setTaxistasActivos([]);
    setPasajerosActivos([]);
    window.location.href = "/login"; // Fuerza redirección limpia
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