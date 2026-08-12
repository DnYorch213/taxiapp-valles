// src/components/PrivateRoute.tsx
import React from "react";
import { Navigate } from "react-router-dom";
import { useTravel } from "../context/TravelContext";

interface PrivateRouteProps {
  children: React.ReactNode;
  role?: "pasajero" | "taxista" | "admin";
}

export const PrivateRoute: React.FC<PrivateRouteProps> = ({ children, role }) => {
  const { userPosition } = useTravel();

  const storedRole = localStorage.getItem("role") as "pasajero" | "taxista" | "admin" | null;
  const resolvedRole = userPosition?.role || storedRole;
  const hasSession = Boolean(userPosition || (localStorage.getItem("email") && storedRole));

  if (!hasSession) {
    return <Navigate to="/login" replace />;
  }

  if (role && resolvedRole !== role) {
    const defaultRoute = resolvedRole === "taxista" ? "/taxista" : "/pasajero";
    return <Navigate to={defaultRoute} replace />;
  }

  return <>{children}</>;
};
