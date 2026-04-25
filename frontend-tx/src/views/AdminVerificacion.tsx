import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';

interface Taxista {
  _id: string;
  name: string;
  email: string;
  taxiNumber: string;
  adminApproval: string;
}

// ... (Tus imports e interfaces igual)

const AdminVerificacion: React.FC = () => {
  const [pendientes, setPendientes] = useState<Taxista[]>([]);
  const [verificados, setVerificados] = useState<Taxista[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [tab, setTab] = useState<'pendientes' | 'verificados'>('pendientes');

  const navigate = useNavigate();
  const token = localStorage.getItem('token'); 
  const role = localStorage.getItem('role');
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

  // 🛡️ PROTECCIÓN DE RUTA
  useEffect(() => {
    if (!token || role !== 'admin') {
      toast.error("Acceso restringido");
      navigate('/login');
    }
  }, [token, role, navigate]);

  // 🔄 CARGA DE DATOS CENTRALIZADA
  const fetchData = async () => {
    setLoading(true);
    try {
      const endpoint = tab === 'pendientes' ? 'pending' : 'verified';
      const res = await axios.get<Taxista[]>(`${API_URL}/api/admin/${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (tab === 'pendientes') setPendientes(res.data);
      else setVerificados(res.data);
      
    } catch (error: any) {
      console.error("Error al cargar:", error);
      toast.error("Error de conexión con VallesControl");
    } finally {
      setLoading(false);
    }
  };

  // Se dispara cada vez que cambias de pestaña
  useEffect(() => {
    if (role === 'admin') fetchData();
  }, [tab]); // <-- Aquí está el truco: escucha el cambio de tab

  const handleAction = async (id: string, action: 'aprobar' | 'rechazar') => {
    if (actionLoading) return;
    setActionLoading(id);
    try {
  await axios.put(`${API_URL}/api/admin/update-status/${id}`, 
    { action },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  
  toast.success(`Operador ${action === 'aprobar' ? 'AUTORIZADO ✅' : 'RECHAZADO ❌'}`);
  
  // 1. Buscamos al taxista en la lista de pendientes antes de quitarlo
  const taxistaAprobado = pendientes.find(t => t._id === id);

  // 2. Quitamos de pendientes
  setPendientes(prev => prev.filter(t => t._id !== id));

  // 3. Si fue aprobado, lo pasamos a la lista de verificados localmente
  if (action === 'aprobar' && taxistaAprobado) {
    setVerificados(prev => [...prev, { ...taxistaAprobado, adminApproval: 'aprobado' }]);
  }
} catch (error) {
      toast.error("No se pudo completar la acción");
    } finally {
      setActionLoading(null);
    }
  };

  // ... (Tu Renderizado igual, está excelente el CSS)

  if (loading) return (
    <div className="h-dvh flex items-center justify-center bg-[#0f172a] text-[#22c55e] animate-pulse font-black italic uppercase tracking-tighter">
      Abriendo Valles Control...
    </div>
  );

 return (
  <div className="min-h-dvh bg-[#0f172a] p-6 text-slate-100 font-sans pb-24">
    <header className="mb-10 flex justify-between items-start">
      <div>
        <h1 className="text-3xl font-black tracking-tighter italic uppercase">
          Valles<span className="text-[#22c55e]">Control</span>
        </h1>
        <p className="text-slate-500 text-[10px] font-bold uppercase tracking-[0.3em]">Gestión de Operadores</p>
      </div>
      <button 
        onClick={() => navigate('/login')} 
        className="p-2 bg-slate-800 rounded-xl text-xs font-bold text-slate-400"
      >
        SALIR
      </button>
    </header>

    {/* 🎫 SELECTOR DE PESTAÑAS */}
    <div className="flex gap-4 mb-8 bg-[#1e293b] p-1 rounded-[1.5rem] border border-white/5">
      <button 
        onClick={() => setTab('pendientes')}
        className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all duration-300 ${
          tab === 'pendientes' 
            ? 'bg-[#22c55e] text-[#0f172a] shadow-lg shadow-[#22c55e]/20' 
            : 'text-slate-400 hover:text-white'
        }`}
      >
        Solicitudes ({pendientes.length})
      </button>
      <button 
        onClick={() => setTab('verificados')}
        className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all duration-300 ${
          tab === 'verificados' 
            ? 'bg-[#22c55e] text-[#0f172a] shadow-lg shadow-[#22c55e]/20' 
            : 'text-slate-400 hover:text-white'
        }`}
      >
        Verificados ({verificados.length})
      </button>
    </div>

    {/* 🔄 RENDERIZADO CONDICIONAL */}
    {tab === 'pendientes' ? (
      <section className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h2 className="text-xs font-black text-[#22c55e] uppercase tracking-widest flex items-center gap-2">
          <span className={`h-2 w-2 bg-[#22c55e] rounded-full ${pendientes.length > 0 ? 'animate-ping' : ''}`}></span>
          Por Autorizar
        </h2>

        {pendientes.length === 0 ? (
          <div className="py-20 text-center border-2 border-dashed border-slate-800 rounded-[2.5rem] opacity-50">
            <p className="text-slate-600 font-bold uppercase text-[10px] mb-2">Buzón de entrada vacío</p>
            <span className="text-3xl">📭</span>
          </div>
        ) : (
          pendientes.map((taxista) => (
            <div key={taxista._id} className="bg-[#1e293b] rounded-[2rem] p-6 border border-white/5 shadow-2xl">
              <div className="flex items-center gap-4 mb-6">
                <div className="h-14 w-14 bg-[#0f172a] rounded-2xl flex items-center justify-center text-2xl border border-white/5">
                  🚕
                </div>
                <div className="flex-1">
                  <h3 className="font-black text-xl leading-tight text-white">{taxista.name}</h3>
                  <p className="text-slate-400 text-xs font-medium truncate w-40">{taxista.email}</p>
                </div>
                <div className="bg-[#22c55e]/10 px-3 py-1 rounded-full border border-[#22c55e]/20">
                  <span className="text-[10px] font-black text-[#22c55e]">ECO-{taxista.taxiNumber}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button 
                  onClick={() => handleAction(taxista._id, 'aprobar')}
                  disabled={!!actionLoading}
                  className={`py-4 rounded-2xl font-black text-xs uppercase transition-all active:scale-95 ${
                    actionLoading === taxista._id 
                      ? 'bg-slate-700 text-slate-500' 
                      : 'bg-[#22c55e] text-[#0f172a] hover:bg-[#1db053]'
                  }`}
                >
                  {actionLoading === taxista._id ? "..." : "Dar de Alta"}
                </button>
                <button 
                  onClick={() => handleAction(taxista._id, 'rechazar')}
                  disabled={!!actionLoading}
                  className="py-4 bg-slate-800 text-slate-400 rounded-2xl font-black text-[10px] uppercase active:scale-95 hover:bg-red-900/20 hover:text-red-400"
                >
                  Rechazar
                </button>
              </div>
            </div>
          ))
        )}
      </section>
    ) : (
      <section className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest flex items-center gap-2 mb-4">
          <span className="h-2 w-2 bg-blue-500 rounded-full"></span>
          Operadores Activos
        </h2>

        {verificados.length === 0 ? (
          <div className="py-20 text-center border-2 border-dashed border-slate-800 rounded-[2.5rem] opacity-50">
            <p className="text-slate-600 font-bold uppercase text-[10px]">No hay personal verificado</p>
          </div>
        ) : (
          verificados.map((taxista) => (
            <div key={taxista._id} className="bg-[#1e293b]/50 rounded-[1.5rem] p-4 border border-white/5 flex items-center justify-between hover:bg-[#1e293b] transition-colors">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 bg-[#0f172a] rounded-xl flex items-center justify-center text-lg border border-white/5">
                  👤
                </div>
                <div>
                  <h3 className="font-bold text-sm text-white">{taxista.name}</h3>
                  <p className="text-[#22c55e] text-[9px] uppercase font-black">ECO-{taxista.taxiNumber}</p>
                </div>
              </div>
              <div className="flex flex-col items-end">
                <span className="bg-blue-500/10 text-blue-400 text-[8px] px-2 py-0.5 rounded-md font-black uppercase mb-1">
                  Verificado
                </span>
                <span className="text-slate-500 text-[9px] font-bold italic">Valles App</span>
              </div>
            </div>
          ))
        )}
      </section>
    )}
  </div>
);
};

export default AdminVerificacion;