import React, { Suspense, lazy } from "react";
import { BrowserRouter as Router, Routes, Route, Link, useNavigate, useLocation } from "react-router-dom";
import { PrivateRoute } from "./components/PrivateRoute";
import { TravelProvider, useTravel } from "./context/TravelContext";
import { socket } from "./lib/socket";

const PasajeroView = lazy(() => import("./views/PasajeroView"));
const TaxistaView = lazy(() => import("./views/TaxistaView"));
const PanelCentral = lazy(() => import("./views/PanelCentral"));
const LoginView = lazy(() => import("./views/LoginView"));
const RegisterView = lazy(() => import("./views/RegisterView"));
const AdminVerificacion = lazy(() => import("./views/AdminVerificacion"));
const AdminHistoryPage = lazy(() => import("./components/AdminHistoryPage"));

if (typeof window !== "undefined") {
  (window as any).socket = socket;
}

const Navbar: React.FC = () => {
  const { userPosition, logout } = useTravel();
  const navigate = useNavigate();

  const handleLogout = () => {
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

const AppLayout: React.FC = () => {
  const location = useLocation();
  const hideNavbarRoutes = ["/pasajero", "/taxista"];
  const shouldShowNavbar = !hideNavbarRoutes.includes(location.pathname);

  const LandingPage = () => (
    <div className="min-h-[calc(100vh-72px)] bg-gradient-to-br from-[#f7f9fb] via-white to-[#e6f4ea] px-4 py-10">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6 text-center lg:text-left">
          <span className="inline-flex items-center rounded-full border border-[#22c55e]/20 bg-[#22c55e]/10 px-4 py-1 text-sm font-semibold tracking-wide text-[#166534]">
            Valles Viaje
          </span>
          <div className="space-y-4">
            <h1 className="text-4xl font-black leading-tight text-slate-900 sm:text-5xl lg:text-6xl">
              Tu taxi aparece primero cuando abres la app.
            </h1>
            <p className="mx-auto max-w-2xl text-base text-slate-600 lg:mx-0 lg:text-lg">
              Arranca con la unidad visible, la identidad clara y acceso rápido a pasajero, taxista o administración.
            </p>
          </div>
          <div className="flex flex-col justify-center gap-3 sm:flex-row lg:justify-start">
            <Link
              to="/login"
              className="inline-flex items-center justify-center rounded-full bg-[#22c55e] px-6 py-3 font-bold text-white shadow-lg shadow-[#22c55e]/30 transition-transform hover:scale-[1.02]"
            >
              Entrar
            </Link>
            <Link
              to="/register"
              className="inline-flex items-center justify-center rounded-full border border-slate-300 bg-white px-6 py-3 font-bold text-slate-700 transition-colors hover:border-[#22c55e] hover:text-[#166534]"
            >
              Crear cuenta
            </Link>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-xl">
          <div className="absolute inset-0 -z-10 rounded-[2rem] bg-[radial-gradient(circle_at_top,_rgba(34,197,94,0.22),_transparent_65%)] blur-2xl" />
          <div className="rounded-[2rem] border border-white/70 bg-white/90 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.12)] backdrop-blur">
            <div className="mb-5 flex items-center justify-between text-sm font-semibold text-slate-500">
              <span>Inicio rápido</span>
              <span className="rounded-full bg-[#22c55e]/10 px-3 py-1 text-[#166534]">Taxi listo</span>
            </div>
            <div className="overflow-hidden rounded-[1.5rem] bg-gradient-to-b from-white to-[#edf7ef] p-4">
              <img
                src="/icons/taxista.png"
                alt="Taxi de inicio de Valles Viaje"
                className="mx-auto w-full max-w-[620px] select-none object-contain"
                draggable="false"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {shouldShowNavbar && <Navbar />}
      <Suspense fallback={<div className="p-8 text-center font-bold">Cargando...</div>}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
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
      </Suspense>
    </>
  );
};

const App: React.FC = () => {
  return (
    <TravelProvider>
      <Router>
        <AppLayout />
      </Router>
    </TravelProvider>
  );
};

export default App;