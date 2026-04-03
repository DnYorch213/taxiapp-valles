import React, { useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";

// 🌐 URL dinámica para producción/desarrollo
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

interface RegisterResponse { 
  message: string;
}

const RegisterView: React.FC = () => {
  const [form, setForm] = useState({ 
    name: "", 
    email: "", 
    password: "", 
    role: "pasajero", 
    taxiNumber: "" 
  });
  
  const navigate = useNavigate();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;

    // ✨ Mejora: Si el usuario deja de ser taxista, limpiamos el número de taxi
    if (name === "role" && value !== "taxista") {
      setForm((prev) => ({ ...prev, [name]: value, taxiNumber: "" }));
    } else {
      setForm((prev) => ({ ...prev, [name]: value }));
    }
  };

 const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();

  // 🛡️ Validación extra antes de disparar la red
  if (form.role === "taxista") {
    const num = parseInt(form.taxiNumber);
    if (isNaN(num) || num < 1 || num > 849) {
      alert("❌ El número de unidad debe estar entre 1 y 849");
      return;
    }
  }

  try {
    const res = await axios.post<RegisterResponse>(`${API_URL}/register`, form);
    alert("✅ " + res.data.message);
    navigate("/login");
  } catch (error: any) {
    const errorMsg = error.response?.data?.message || "Error al conectar con el servidor";
    alert("⚠️ " + errorMsg);
  }
};

 return (
  <div className="min-h-screen bg-slate-50 flex flex-col justify-center p-6 relative overflow-hidden font-sans">
    
    {/* 🟢 Franja decorativa superior (Identidad del Taxi) */}
    <div className="absolute top-0 left-0 w-full h-3 bg-[#22c55e]"></div>

    <div className="max-w-md w-full mx-auto bg-white rounded-[2.5rem] shadow-2xl p-8 border border-slate-100 relative z-10">
      
      {/* HEADER DE REGISTRO */}
      <div className="mb-8 text-center">
        <div className="inline-block p-4 bg-white border-2 border-[#006341] rounded-3xl mb-4 shadow-sm transform -rotate-3">
          <span className="text-3xl">🚖</span>
        </div>
        <h2 className="text-3xl font-black text-slate-800 tracking-tighter leading-none">
          CREAR<span className="text-[#22c55e]">CUENTA</span>
        </h2>
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-2">Únete a la red de transporte de Valles</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        
        {/* NOMBRE */}
        <div>
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-1 block">Nombre completo</label>
          <input
            type="text" name="name" value={form.name} onChange={handleChange} required
            className="w-full p-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-[#22c55e] transition-all outline-none font-medium text-slate-700 placeholder:text-slate-300"
            placeholder="Ej. Jorge Pérez"
          />
        </div>

        {/* CORREO */}
        <div>
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-1 block">Correo electrónico</label>
          <input
            type="email" name="email" value={form.email} onChange={handleChange} required
            className="w-full p-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-[#22c55e] transition-all outline-none font-medium text-slate-700 placeholder:text-slate-300"
            placeholder="correo@ejemplo.com"
          />
        </div>

        {/* CONTRASEÑA */}
        <div>
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-1 block">Contraseña</label>
          <input
            type="password" name="password" value={form.password} onChange={handleChange} required
            className="w-full p-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-[#22c55e] transition-all outline-none font-medium text-slate-700 placeholder:text-slate-300"
            placeholder="••••••••"
          />
        </div>

        {/* TIPO DE USUARIO */}
        <div>
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-1 block">¿Quién eres?</label>
          <select
            name="role" value={form.role} onChange={handleChange}
            className="w-full p-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-[#22c55e] transition-all outline-none font-bold text-[#22c55e] appearance-none"
          >
            <option value="pasajero">Soy Pasajero 🙋‍♂️</option>
            <option value="taxista">Soy Taxista 🚖</option>
          </select>
        </div>

        {/* NÚMERO DE UNIDAD (Solo Taxista) */}
       {form.role === "taxista" && (
  <div className="animate-in fade-in slide-in-from-top-2">
    <label className="text-[10px] font-black text-[#22c55e] uppercase tracking-widest ml-4 mb-1 block">Número de Taxi (1-849)</label>
    <input
      type="number" // Cambiado a number para teclado numérico en móvil
      name="taxiNumber"
      value={form.taxiNumber}
      onChange={handleChange}
      min="1"
      max="849"
      required
      className="w-full p-4 bg-[#22c55e]/5 border-2 border-[#22c55e]/20 rounded-2xl focus:ring-2 focus:ring-[#22c55e] transition-all outline-none font-black text-[#22c55e]"
      placeholder="Ej. 045"
    />
  </div>
)}

        <button 
          type="submit" 
          className="w-full bg-[#22c55e] text-white py-5 rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-[#1a9a4a] transition-all shadow-xl shadow-green-900/20 active:scale-95 mt-4"
        >
          Finalizar Registro
        </button>
      </form>

      <p className="mt-8 text-center text-xs font-bold text-slate-400 uppercase tracking-tighter">
        ¿Ya tienes cuenta? <span onClick={() => navigate("/login")} className="text-[#22c55e] cursor-pointer hover:underline">Inicia sesión</span>
      </p>
    </div>

    {/* 🟢 Franja inferior sutil */}
    <div className="absolute bottom-0 left-0 w-full h-1 bg-[#22c55e]/10"></div>
  </div>
);
};

export default RegisterView;