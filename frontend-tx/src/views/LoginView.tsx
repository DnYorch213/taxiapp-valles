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
      socket.auth = { email: email, token: token }; // 🔐 Enviamos el token también
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
    <div className="min-h-screen bg-white flex flex-col justify-center p-8">
      <div className="max-w-md w-full mx-auto">
        <div className="mb-12">
          <h2 className="text-4xl font-black text-slate-900 mb-2">Bienvenido</h2>
          <p className="text-slate-500 font-medium">Inicia sesión para empezar a moverte.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-bold text-slate-400 uppercase ml-1">Correo electrónico</label>
            <input
              type="email" name="email" value={form.email} onChange={handleChange} required
              className="w-full p-4 mt-1 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-yellow-400 transition-all font-medium outline-none"
              placeholder="ejemplo@correo.com"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-400 uppercase ml-1">Contraseña</label>
            <input
              type="password" name="password" value={form.password} onChange={handleChange} required
              className="w-full p-4 mt-1 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-yellow-400 transition-all font-medium outline-none"
              placeholder="••••••••"
            />
          </div>
          
          <button 
            type="submit" 
            disabled={loading}
            className={`w-full py-4 ${loading ? 'bg-slate-300' : 'bg-yellow-400 hover:bg-yellow-500'} text-slate-900 rounded-2xl font-black text-lg transition-all shadow-xl shadow-yellow-100 mt-6 active:scale-95`}
          >
            {loading ? "CARGANDO..." : "INGRESAR"}
          </button>
        </form>

        <p className="mt-8 text-center text-sm font-medium text-slate-400">
          ¿No tienes cuenta? <span onClick={() => navigate("/register")} className="text-yellow-600 cursor-pointer hover:underline">Regístrate aquí</span>
        </p>
      </div>
    </div>
  );
};

export default LoginView;