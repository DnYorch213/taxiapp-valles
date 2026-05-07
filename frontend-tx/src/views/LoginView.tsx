import React, { useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import { useTravel } from "../context/TravelContext";
import { socket, connectSocket } from "../lib/socket";
// Busca esta línea y cámbiala así:

const API_URL = window.location.hostname === 'localhost' 
    ? "http://localhost:3001" 
    : import.meta.env.VITE_API_URL;
interface LoginResponse {
  token: string;
  role: "pasajero" | "taxista" | "admin";
  name: string;
  taxiNumber?: string;
  email: string;
  lastCoords?: { lat: number; lng: number } | null;
  adminApproval?: "pendiente" | "aprobado" | "rechazado";
}

const LoginView: React.FC = () => {
  const [form, setForm] = useState({ email: "", password: "" });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { setUserPosition } = useTravel();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

 const establishSession = (data: LoginResponse) => {
    const { token, role, name, taxiNumber, email, lastCoords } = data;
    const cleanEmail = email.toLowerCase().trim();

    // 1. Almacenamiento local
    localStorage.setItem("token", token);
    localStorage.setItem("email", cleanEmail);
    localStorage.setItem("role", role);
    localStorage.setItem("userName", name);
    if (taxiNumber) localStorage.setItem("taxiNumber", taxiNumber);

    // 2. Sincronización de Socket (Usando tu nueva función)
    // Esto es mucho más limpio y evita errores de conexión
    connectSocket(cleanEmail, role);

    // 3. Estado global de posición
    setUserPosition({
      email: cleanEmail,
      id: cleanEmail,
      name,
      lat: lastCoords?.lat || 21.9850,
      lng: lastCoords?.lng || -99.0150,
      role,
      taxiNumber,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);

    try {
      const { data } = await axios.post<LoginResponse>(`${API_URL}/api/auth/login`, {
        ...form,
        email: form.email.toLowerCase().trim(),
      });

       // 🚩 Forzamos que sea string para evitar que el undefined rompa el .trim()
       const status = String(data.adminApproval || "").toLowerCase().trim();

      // 🛡️ REGLA DE NEGOCIO: Solo el taxista requiere aprobación previa
      if (data.role === "taxista" && status !== "aprobado") {
        const messages = {
          rechazado: "❌ Acceso denegado por la administración.",
          pendiente: "⏳ Tu cuenta de taxista está en revisión.",
          default: "⏳ Esperando autorización de VallesControl."
        };
        alert(messages[status as keyof typeof messages] || messages.default);
        setLoading(false);
        return;
      }

      // Si es pasajero o taxista aprobado, establecemos sesión
      establishSession(data);

      const routes = { pasajero: "/pasajero", taxista: "/taxista", admin: "/panel" };
      navigate(routes[data.role]);

    } catch (error: any) {
      console.error("❌ Login Error:", error);
      alert(error.response?.data?.message || "Error de conexión con Valles");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col justify-center p-8 relative overflow-hidden font-sans">
      {/* Línea decorativa superior */}
      <div className="absolute top-0 left-0 w-full h-3 bg-[#22c55e]"></div>

      <div className="max-w-md w-full mx-auto z-10">
        {/* Header de la App */}
        <header className="mb-12">
          <div className="inline-block p-3 bg-white border-2 border-[#22c55e] rounded-2xl mb-4 shadow-sm">
            <span className="text-2xl">🚕</span>
          </div>
          <h1 className="text-4xl font-black text-slate-900 mb-1 tracking-tighter uppercase">
            TAXI<span className="text-[#22c55e]">VALLES</span>
          </h1>
          <p className="text-slate-400 font-bold text-[10px] uppercase tracking-widest leading-relaxed">
            Plataforma de Transporte Público<br />Cd. Valles, S.L.P.
          </p>
        </header>

        {/* Formulario */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <InputGroup
            label="Correo electrónico"
            type="email"
            name="email"
            value={form.email}
            onChange={handleChange}
            placeholder="ejemplo@correo.com"
          />

          <InputGroup
            label="Contraseña"
            type="password"
            name="password"
            value={form.password}
            onChange={handleChange}
            placeholder="••••••••"
          />

          <button
            type="submit"
            disabled={loading}
            className={`w-full py-5 rounded-2xl font-black text-sm uppercase tracking-widest transition-all shadow-xl mt-4 ${
              loading
                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                : 'bg-[#22c55e] hover:bg-[#1a9a4a] text-white active:scale-95 shadow-green-900/10'
            }`}
          >
            {loading ? "VERIFICANDO..." : "INGRESAR AL SISTEMA"}
          </button>
        </form>

        <footer className="mt-10 text-center">
          <p className="text-sm font-bold text-slate-400">
            ¿No tienes cuenta?{" "}
            <span
              onClick={() => navigate("/register")}
              className="text-[#22c55e] cursor-pointer hover:underline decoration-2 underline-offset-4"
            >
              Crea una aquí
            </span>
          </p>
        </footer>
      </div>

      {/* Decoración inferior */}
      <div className="absolute bottom-0 left-0 w-full h-1 bg-[#22c55e]/20"></div>
    </div>
  );
};

// 🧩 Sub-componente para inputs (limpieza visual)
const InputGroup: React.FC<{
  label: string;
  type: string;
  name: string;
  value: string;
  placeholder: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}> = ({ label, type, name, value, onChange, placeholder }) => (
  <div className="group">
    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 transition-colors group-focus-within:text-[#22c55e]">
      {label}
    </label>
    <input
      type={type}
      name={name}
      value={value}
      onChange={onChange}
      required
      className="w-full p-4 mt-1 bg-slate-50 border-2 border-transparent rounded-2xl focus:border-[#22c55e] focus:bg-white transition-all font-medium outline-none text-slate-700"
      placeholder={placeholder}
    />
  </div>
);

export default LoginView;