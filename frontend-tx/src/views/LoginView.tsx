import React, { useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import { useTravel } from "../context/TravelContext";
import { socket } from "../lib/socket"; 

// 🌐 Definimos la URL fuera para que no se cree en cada click
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
  const [loading, setLoading] = useState(false); // ⏳ Estado de carga
  const navigate = useNavigate();
  const { setUserPosition } = useTravel();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await axios.post<LoginResponse>(`${API_URL}/login`, form);
      const { token, role, name, taxiNumber, email } = res.data;

      // 1. Limpieza de seguridad: Borramos rastros de sesiones anteriores
      localStorage.clear();

      // 2. Guardado consistente
      localStorage.setItem("token", token);
      localStorage.setItem("email", email);
      localStorage.setItem("role", role);
      localStorage.setItem("userName", name);
      if (taxiNumber) localStorage.setItem("taxiNumber", taxiNumber);

      // 3. Sincronización de Socket (Crucial para el despacho en cascada)
      socket.auth = { email: email, token: token, role: role }; // 🔐 Enviamos el token también
      socket.disconnect().connect(); 

      // 4. Actualizamos el Contexto Global
      setUserPosition({
        email: email,
        id: email,
        name: name,
        lat: 0,
        lng: 0,
        role: role,
        taxiNumber: role === "taxista" ? taxiNumber : undefined,
      });

      // 5. Redirección basada en roles
      const routes = {
        pasajero: "/pasajero",
        taxista: "/taxista",
        admin: "/panel"
      };
      
      navigate(routes[role]);

    } catch (error: any) {
      console.error("Error en el login:", error);
      const msg = error.response?.data?.message || "Error de conexión con el servidor";
      alert(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
  <div className="min-h-screen bg-white flex flex-col justify-center p-8 relative overflow-hidden">
    
    {/* 🟢 Detalle de Identidad: Franja superior Verde Bandera */}
    <div className="absolute top-0 left-0 w-full h-3 bg-[#22c55e]"></div>

    <div className="max-w-md w-full mx-auto z-10">
      <div className="mb-12">
        {/* Icono representativo opcional */}
        <div className="inline-block p-3 bg-white border-2 border-[#22c55e] rounded-2xl mb-4 shadow-sm">
          <span className="text-2xl">🚕</span>
        </div>
        <h2 className="text-4xl font-black text-slate-900 mb-1 tracking-tighter">
          TAXI<span className="text-[#22c55e]">VALLES</span>
        </h2>
        <p className="text-slate-400 font-bold text-xs uppercase tracking-widest">
          Taxistas de Automoviles de Alquiler - CD. VALLES
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
            className="w-full p-4 mt-1 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-[#22c55e] transition-all font-medium outline-none text-slate-700"
            placeholder="••••••••"
          />
        </div>
        
        <button 
          type="submit" 
          disabled={loading}
          className={`w-full py-5 ${
            loading ? 'bg-slate-200 text-slate-400' : 'bg-[#22c55e] hover:bg-[#1a9a4a] text-white'
          } rounded-2xl font-black text-sm uppercase tracking-widest transition-all shadow-xl shadow-green-900/10 mt-6 active:scale-95`}
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

    {/* 🟢 Franja inferior decorativa para cerrar el diseño */}
    <div className="absolute bottom-0 left-0 w-full h-1 bg-[#22c55e]/20"></div>
  </div>
);
};

export default LoginView;