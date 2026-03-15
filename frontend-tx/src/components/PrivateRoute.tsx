// src/components/PrivateRoute.tsx
import React from "react";
import { Navigate } from "react-router-dom";
import { useTravel } from "../context/TravelContext";

interface PrivateRouteProps {
  children: React.ReactNode;
  role?: "pasajero" | "taxista" | "admin"; // 👈 tipado fuerte
}

export const PrivateRoute: React.FC<PrivateRouteProps> = ({ children, role }) => {
  const { userPosition } = useTravel();

  // Si no hay usuario en contexto, redirige a login
  if (!userPosition) {
    return <Navigate to="/login" />;
  }

  // Si hay rol requerido y no coincide, redirige a home
  if (role && userPosition.role !== role) {
    return <Navigate to="/" />;
  }

  return children;
};
