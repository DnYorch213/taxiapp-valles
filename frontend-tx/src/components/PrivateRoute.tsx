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

  const storedToken = localStorage.getItem("token");
  const storedRole = localStorage.getItem("role") as "pasajero" | "taxista" | "admin" | null;
  const resolvedRole = userPosition?.role || storedRole;

  if (!userPosition && !storedToken) {
    return <Navigate to="/login" replace />; // 👈 replace es clave aquí
  }

  if (role && resolvedRole !== role) {
    // Si es taxista y quiere entrar a admin, mejor mándalo a su vista de /taxista
    const defaultRoute = resolvedRole === "taxista" ? "/taxista" : "/pasajero";
    return <Navigate to={defaultRoute} replace />;
  }

  return <>{children}</>;
};
