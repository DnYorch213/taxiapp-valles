import React, { useEffect, useState } from 'react';
import axios from 'axios';

// 🌐 URL dinámica para producción/desarrollo
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

export const HistorialViajes: React.FC<{ email: string }> = ({ email }) => {
  const [viajes, setViajes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const res = await axios.get(`${API_URL}/api/history/${email}`);
        setViajes(res.data as any[]);
      } catch (err) {
        console.error("Error al cargar historial", err);
      } finally {
        setLoading(false);
      }
    };
    if (email) fetchHistory();
  }, [email]);

  return (
    <div className="p-4 pb-20">
      <h2 className="text-xl font-black mb-6 text-white italic">MIS VIAJES</h2>
      {loading ? (
        <p className="text-slate-500 animate-pulse text-xs">Cargando registros...</p>
      ) : viajes.length === 0 ? (
        <p className="text-slate-500 text-xs">No tienes viajes registrados hoy.</p>
      ) : (
        <div className="space-y-3">
          {viajes.map((v) => (
            <div key={v._id} className="bg-[#1e293b] p-4 rounded-2xl border border-white/5 shadow-lg">
              <div className="flex justify-between items-start mb-2">
                <span className="text-[10px] font-black text-[#22c55e] uppercase tracking-widest">
                  {new Date(v.fecha).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-[9px] bg-white/10 px-2 py-1 rounded-full text-slate-400">
                  {new Date(v.fecha).toLocaleDateString()}
                </span>
              </div>
              <p className="text-sm font-bold text-white capitalize">{v.pasajeroName}</p>
              <p className="text-[10px] text-slate-500 mt-1 truncate">📍 {v.pickupAddress}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};