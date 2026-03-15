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
    try {
      // 🚀 Petición usando la URL del entorno
      const res = await axios.post<RegisterResponse>(`${API_URL}/register`, form);
      alert(res.data.message);
      navigate("/login");
    } catch (error: any) {
      // ⚠️ Manejo de errores detallado (ej: correo duplicado)
      const errorMsg = error.response?.data?.message || "Error al conectar con el servidor";
      alert(errorMsg);
      console.error("Error en registro:", error);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <form onSubmit={handleSubmit} className="bg-white p-6 rounded-lg shadow-md w-full max-w-sm">
        <h2 className="text-xl font-bold mb-4 text-center">Crear Cuenta</h2>
        
        <input
          type="text"
          name="name"
          placeholder="Nombre completo"
          value={form.name}
          onChange={handleChange}
          required
          className="w-full mb-3 p-2 border rounded focus:ring-2 focus:ring-blue-500 outline-none"
        />
        
        <input
          type="email"
          name="email"
          placeholder="Correo electrónico"
          value={form.email}
          onChange={handleChange}
          required
          className="w-full mb-3 p-2 border rounded focus:ring-2 focus:ring-blue-500 outline-none"
        />
        
        <input
          type="password"
          name="password"
          placeholder="Contraseña"
          value={form.password}
          onChange={handleChange}
          required
          className="w-full mb-3 p-2 border rounded focus:ring-2 focus:ring-blue-500 outline-none"
        />

        <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de usuario</label>
        <select
          name="role"
          value={form.role}
          onChange={handleChange}
          className="w-full mb-3 p-2 border rounded bg-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="pasajero">Pasajero</option>
          <option value="taxista">Taxista</option>
          <option value="admin">Administrador</option>
        </select>

        {form.role === "taxista" && (
          <input
            type="text"
            name="taxiNumber"
            placeholder="Número de unidad (Ej: TX-123)"
            value={form.taxiNumber}
            onChange={handleChange}
            required
            className="w-full mb-3 p-2 border rounded border-blue-300 bg-blue-50 focus:ring-2 focus:ring-blue-500 outline-none"
          />
        )}

        <button 
          type="submit" 
          className="w-full bg-blue-600 text-white py-2 rounded font-semibold hover:bg-blue-700 transition-colors shadow-sm"
        >
          Finalizar Registro
        </button>
        
        <p className="mt-4 text-center text-sm text-gray-600">
          ¿Ya tienes cuenta? <span onClick={() => navigate("/login")} className="text-blue-600 cursor-pointer hover:underline">Inicia sesión</span>
        </p>
      </form>
    </div>
  );
};

export default RegisterView;