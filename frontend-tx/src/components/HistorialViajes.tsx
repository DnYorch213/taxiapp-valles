import React, { useEffect, useState } from 'react';
import axios from 'axios';

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
      <h2 className="text-xl font-black mb-6 text-white italic tracking-tighter">MIS VIAJES</h2>
      
      {loading ? (
        <p className="text-slate-500 animate-pulse text-xs">Cargando registros...</p>
      ) : viajes.length === 0 ? (
        <p className="text-slate-500 text-xs italic">No tienes viajes registrados hoy.</p>
      ) : (
        <div className="space-y-4">
          {viajes.map((v) => (
            <div key={v._id} className="bg-[#1e293b] p-5 rounded-[2rem] border border-white/5 shadow-xl">
              
              {/* HEADER: Hora y Fecha */}
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-[#22c55e]"></div>
                  <span className="text-[10px] font-black text-white uppercase tracking-[0.2em]">
                    {new Date(v.fecha).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <span className="text-[9px] font-bold text-slate-500 bg-black/20 px-3 py-1 rounded-full">
                  {new Date(v.fecha).toLocaleDateString()}
                </span>
              </div>

              {/* CUERPO: Trayecto Origen -> Destino */}
              <div className="space-y-3 mb-4">
                {/* ORIGEN */}
                <div className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className="w-2 h-2 rounded-full bg-[#22c55e] mt-1"></div>
                    <div className="w-[1px] h-6 bg-slate-700 my-1"></div>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Recogida</span>
                    <p className="text-[11px] text-slate-300 font-medium leading-tight line-clamp-1">
                      {v.pickupAddress || "Dirección no disponible"}
                    </p>
                  </div>
                </div>

                {/* DESTINO (🚩 AGREGADO AQUÍ) */}
                <div className="flex gap-3">
                  <div className="w-2 h-2 rounded-full bg-red-500 mt-1"></div>
                  <div className="flex flex-col">
                    <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Destino Final</span>
                    <p className="text-[11px] text-white font-bold leading-tight line-clamp-1">
                      {v.destinationAddress || "Finalizado en punto"}
                    </p>
                  </div>
                </div>
              </div>

              {/* FOOTER: Nombre del pasajero */}
              <div className="pt-3 border-t border-white/5 flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-[#22c55e]/10 flex items-center justify-center text-[10px]">👤</div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider italic">
                  {v.pasajeroName || "Pasajero"}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};