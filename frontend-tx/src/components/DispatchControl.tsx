import React, { useState, useEffect } from "react";
import { socket } from "../lib/socket"; // Asegúrate de que la ruta sea correcta
import { toast } from "react-toastify";

const DispatchControl: React.FC = () => {
  const [isAuto, setIsAuto] = useState(false);

  // Escuchar cambios de otros administradores o del servidor
  useEffect(() => {
    if (!socket) return;

    socket.on("dispatch_mode_changed", (data: { auto: boolean }) => {
      setIsAuto(data.auto);
    });

    return () => {
      socket.off("dispatch_mode_changed");
    };
  }, []);

  const toggleMode = () => {
    const nextMode = !isAuto;
    // Enviamos el cambio al servidor
    socket.emit("toggle_dispatch_mode", { auto: nextMode });
    
    if (nextMode) {
      toast.success("🤖 MODO AUTOMÁTICO: El sistema asignará al más cercano.");
    } else {
      toast.info("👤 MODO MANUAL: Tú tienes el control de las asignaciones.");
    }
  };

  return (
    <div className={`mb-8 p-6 rounded-[2rem] transition-all duration-700 border ${
      isAuto 
        ? "bg-indigo-950 border-indigo-500 shadow-[0_0_30px_rgba(99,102,241,0.2)]" 
        : "bg-slate-800 border-slate-700 shadow-xl"
    }`}>
      <div className="flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-white font-black text-2xl tracking-tighter">
              CONTROL DE DESPACHO
            </h2>
            <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase animate-pulse ${
              isAuto ? "bg-green-500 text-green-950" : "bg-slate-600 text-slate-300"
            }`}>
              {isAuto ? "Live: Algoritmo Haversine" : "Esperando Acción Manual"}
            </span>
          </div>
          <p className="text-slate-400 text-sm mt-1">
            {isAuto 
              ? "Las solicitudes se procesan automáticamente por cercanía." 
              : "Selecciona manualmente un taxi para cada pasajero."}
          </p>
        </div>

        {/* --- BOTÓN TOGGLE TIPO IPHONE --- */}
        <button 
          onClick={toggleMode}
          className={`group relative h-14 w-44 rounded-2xl p-1 transition-all duration-500 ${
            isAuto ? "bg-green-500" : "bg-slate-700"
          }`}
        >
          <div className={`flex items-center justify-between px-4 w-full h-full font-black text-xs transition-all ${
            isAuto ? "text-white" : "text-slate-400"
          }`}>
            <span className={isAuto ? "opacity-0" : "opacity-100"}>MANUAL</span>
            <span className={isAuto ? "opacity-100" : "opacity-0"}>AUTO</span>
          </div>
          
          <div className={`absolute top-1 left-1 h-12 w-20 rounded-xl bg-white shadow-lg transition-all duration-500 transform ${
            isAuto ? "translate-x-22" : "translate-x-0"
          } flex items-center justify-center text-xl`}>
            {isAuto ? "🤖" : "👤"}
          </div>
        </button>
      </div>
    </div>
  );
};

export default DispatchControl;