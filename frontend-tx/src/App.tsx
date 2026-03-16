// src/App.tsx
import React from "react";
import { BrowserRouter as Router, Routes, Route, Link, useNavigate } from "react-router-dom";
import PasajeroView from "./views/PasajeroView";
import TaxistaView from "./views/TaxistaView";
import PanelCentral from "./views/PanelCentral";
import LoginView from "./views/LoginView";
import RegisterView from "./views/RegisterView";
import { PrivateRoute } from "./components/PrivateRoute";
import { TravelProvider, useTravel } from "./context/TravelContext";
import PanelSolicitudes from "./views/PanelSolicitudes";
import { socket } from "./lib/socket";

if (typeof window !== "undefined") {
  (window as any).socket = socket;
}

const Navbar: React.FC = () => {
  const { userPosition, logout } = useTravel();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    socket.disconnect(); // Desconectamos el socket al hacer logout
    navigate("/login");
  };

  return (
    <div className="p-4 bg-gray-100 shadow-md flex justify-between items-center">
      <h1 className="text-xl font-bold">🚖 App de Viajes</h1>
      <nav className="space-x-4">
        {!userPosition ? (
          <>
            <Link to="/login" className="text-blue-600 hover:underline">Login</Link>
            <Link to="/register" className="text-blue-600 hover:underline">Registro</Link>
          </>
        ) : (
          <>
            {userPosition.role === "pasajero" && (
              <Link to="/pasajero" className="text-blue-600 hover:underline">Pasajero</Link>
            )}
            {userPosition.role === "taxista" && (
              <Link to="/taxista" className="text-blue-600 hover:underline">Taxista</Link>
            )}
            {userPosition.role === "admin" && (
              <>
                <Link to="/panel" className="text-blue-600 hover:underline">Panel Central</Link>
                <Link to="/panelSolicitudes" className="text-blue-600 hover:underline">Panel de Solicitudes</Link>
              </>
            )}
            <button
              onClick={handleLogout}
              className="ml-4 bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700"
            >
              Logout
            </button>
          </>
        )}
      </nav>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <TravelProvider>
      <Router>
        <Navbar />
        <Routes>
          <Route path="/" element={<div className="p-8 text-center">Bienvenido 🚕</div>} />
          <Route path="/login" element={<LoginView />} />
          <Route path="/register" element={<RegisterView />} />

          {/* Rutas protegidas */}
          <Route path="/pasajero" element={<PrivateRoute role="pasajero"><PasajeroView /></PrivateRoute>} />
          <Route path="/taxista" element={<PrivateRoute role="taxista"><TaxistaView /></PrivateRoute>} />
          <Route path="/panel" element={<PrivateRoute role="admin"><PanelCentral /></PrivateRoute>} />
          <Route path="/panelSolicitudes" element={<PrivateRoute role="admin"><PanelSolicitudes /></PrivateRoute>} />
        </Routes>
      </Router>
    </TravelProvider>
  );
};

export default App;
