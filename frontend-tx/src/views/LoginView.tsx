import React, { useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import { useTravel } from "../context/TravelContext";
import { socket } from "../lib/socket"; 

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

interface LoginResponse {
  token: string;
  role: "pasajero" | "taxista" | "admin";
  name: string; 
  taxiNumber?: string;
  email: string;
}

const LoginView: React.FC = () => {
  const [form, setForm] = useState({ email: "", password: "" });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { setUserPosition } = useTravel();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);

    // Normalizamos el email para evitar errores de redacción
    const cleanEmail = form.email.toLowerCase().trim();

    try {
      const res = await axios.post<LoginResponse>(`${API_URL}/login`, {
        ...form,
        email: cleanEmail
      });
      
      const { token, role, name, taxiNumber, email } = res.data;

      // 1. Limpieza total de seguridad
      localStorage.clear();

      // 2. Persistencia de sesión
      localStorage.setItem("token", token);
      localStorage.setItem("email", email.toLowerCase());
      localStorage.setItem("role", role);
      localStorage.setItem("userName", name);
      if (taxiNumber) localStorage.setItem("taxiNumber", taxiNumber);

      // 3. Re-conexión de Socket con nuevas credenciales
      // Es vital desconectar y volver a conectar para que el backend reconozca el nuevo rol
      socket.auth = { email: email.toLowerCase(), token, role };
      socket.disconnect().connect(); 

      // 4. Inicializamos el Contexto Global
      // lat/lng en 0 es temporal hasta que useGeolocation tome el control en la siguiente vista
      setUserPosition({
        email: email.toLowerCase(),
        id: email.toLowerCase(),
        name: name,
        lat: 0, 
        lng: 0,
        role: role,
        taxiNumber: role === "taxista" ? taxiNumber : undefined,
      });

      // 5. Redirección por Rol
      const routes = {
        pasajero: "/pasajero",
        taxista: "/taxista",
        admin: "/panel"
      };
      
      navigate(routes[role]);

    } catch (error: any) {
      console.error("❌ Error en login:", error);
      const msg = error.response?.data?.message || "Error de conexión con el servidor";
      alert(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col justify-center p-8 relative overflow-hidden">
      {/* Detalle Identidad Valles */}
      <div className="absolute top-0 left-0 w-full h-3 bg-[#22c55e]"></div>

      <div className="max-w-md w-full mx-auto z-10">
        <div className="mb-12">
          <div className="inline-block p-3 bg-white border-2 border-[#22c55e] rounded-2xl mb-4 shadow-sm">
            <span className="text-2xl">🚕</span>
          </div>
          <h2 className="text-4xl font-black text-slate-900 mb-1 tracking-tighter">
            TAXI<span className="text-[#22c55e]">VALLES</span>
          </h2>
          <p className="text-slate-400 font-bold text-[10px] uppercase tracking-widest leading-relaxed">
            Sindicato de Choferes de Automóviles de Alquiler<br/>Cd. Valles, S.L.P.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">
              Correo electrónico
            </label>
            <input
              type="email" 
              name="email" 
              value={form.email} 
              onChange={handleChange} 
              required
              autoComplete="email"
              className="w-full p-4 mt-1 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-[#22c55e] transition-all font-medium outline-none text-slate-700"
              placeholder="ejemplo@correo.com"
            />
          </div>

          <div>
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">
              Contraseña
            </label>
            <input
              type="password" 
              name="password" 
              value={form.password} 
              onChange={handleChange} 
              required
              autoComplete="current-password"
              className="w-full p-4 mt-1 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-[#22c55e] transition-all font-medium outline-none text-slate-700"
              placeholder="••••••••"
            />
          </div>
          
          <button 
            type="submit" 
            disabled={loading}
            className={`w-full py-5 ${
              loading ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-[#22c55e] hover:bg-[#1a9a4a] text-white active:scale-95'
            } rounded-2xl font-black text-sm uppercase tracking-widest transition-all shadow-xl shadow-green-900/10 mt-6`}
          >
            {loading ? "VERIFICANDO..." : "INGRESAR AL SISTEMA"}
          </button>
        </form>

        <p className="mt-10 text-center text-sm font-bold text-slate-400">
          ¿No tienes cuenta? <span 
            onClick={() => navigate("/register")} 
            className="text-[#22c55e] cursor-pointer hover:underline decoration-2 underline-offset-4"
          >
            Crea una aquí
          </span>
        </p>
      </div>

      <div className="absolute bottom-0 left-0 w-full h-1 bg-[#22c55e]/20"></div>
    </div>
  );
};

export default LoginView;