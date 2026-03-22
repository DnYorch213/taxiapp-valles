// src/components/PrivateRoute.tsx
import React from "react";
import { Navigate } from "react-router-dom";
import { useTravel } from "../context/TravelContext";

interface PrivateRouteProps {
  children: React.ReactNode;
  role?: "pasajero" | "taxista" | "admin"; // 👈 tipado fuerte
}

// Tu componente con el toque final:
export const PrivateRoute: React.FC<PrivateRouteProps> = ({ children, role }) => {
  const { userPosition } = useTravel();

  if (!userPosition) {
    return <Navigate to="/login" replace />; // 👈 replace es clave aquí
  }

  if (role && userPosition.role !== role) {
    // Si es taxista y quiere entrar a admin, mejor mándalo a su vista de /taxista
    const defaultRoute = userPosition.role === "taxista" ? "/taxista" : "/pasajero";
    return <Navigate to={defaultRoute} replace />;
  }

  return <>{children}</>;
};
