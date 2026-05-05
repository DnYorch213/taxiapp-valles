import React from "react";
import { BrowserRouter as Router, Routes, Route, Link, useNavigate } from "react-router-dom";
import PasajeroView from "./views/PasajeroView";
import TaxistaView from "./views/TaxistaView";
import PanelCentral from "./views/PanelCentral";
import LoginView from "./views/LoginView";
import RegisterView from "./views/RegisterView";
import { PrivateRoute } from "./components/PrivateRoute";
import { TravelProvider, useTravel } from "./context/TravelContext";
import { socket } from "./lib/socket";
import AdminVerificacion from "./views/AdminVerificacion";
import AdminHistoryPage from './components/AdminHistoryPage'; 

if (typeof window !== "undefined") {
  (window as any).socket = socket;
}

const Navbar: React.FC = () => {
  const { userPosition, logout } = useTravel();
  const navigate = useNavigate();

  const handleLogout = () => {
    socket.emit("force_disconnect", { email: userPosition?.email });
    logout(); 
    socket.disconnect(); 
    navigate("/login");
  };

  return (
    <div className="p-4 bg-gray-100 shadow-md flex justify-between items-center">
      <h1 className="text-xl font-bold italic">Valles<span className="text-[#22c55e]">Control</span></h1>
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
                <Link to="/panel" className="text-blue-600 hover:underline font-bold">Monitor</Link>
                {/* ✅ Solo dejamos este link que es el funcional */}
                <Link to="/verificar-taxistas" className="text-[#22c55e] hover:underline font-black italic">
                  AUTORIZAR 🚖
                </Link>
                <Link to="/historial-viajes" className="text-[#22c55e] hover:underline font-black italic">
                  HISTORIAL 🕒
                </Link>
              </>
            )}
            <button
              onClick={handleLogout}
              className="ml-4 bg-red-600 text-white px-3 py-1 rounded font-bold hover:bg-red-700 transition-colors"
            >
              Salir
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
          <Route path="/" element={<div className="p-8 text-center font-bold">Bienvenido a Valles Viaje 🚕</div>} />
          <Route path="/login" element={<LoginView />} />
          <Route path="/register" element={<RegisterView />} />

          {/* Rutas protegidas */}
          <Route path="/pasajero" element={<PrivateRoute role="pasajero"><PasajeroView /></PrivateRoute>} />
          <Route path="/taxista" element={<PrivateRoute role="taxista"><TaxistaView /></PrivateRoute>} />
          <Route path="/panel" element={<PrivateRoute role="admin"><PanelCentral /></PrivateRoute>} />
          
          {/* ✅ Esta es la ruta principal de administración ahora */}
          <Route path="/verificar-taxistas" element={<PrivateRoute role="admin"><AdminVerificacion /></PrivateRoute>} />
          <Route path="/historial-viajes" element={<PrivateRoute role="admin"><AdminHistoryPage /></PrivateRoute>} />
        </Routes>
      </Router>
    </TravelProvider>
  );
};

export default App;