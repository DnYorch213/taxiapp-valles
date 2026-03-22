import React, { useState, useEffect } from "react";
import { socket } from "../lib/socket"; 
import { toast } from "react-toastify";

const DispatchControl: React.FC = () => {
  const [isAuto, setIsAuto] = useState(false);

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
    if (!socket.connected) {
      toast.error("Error de conexión con el servidor");
      return;
    }

    const nextMode = !isAuto;
    socket.emit("toggle_dispatch_mode", { auto: nextMode });
    
    if (nextMode) {
      toast.success("🤖 MODO AUTOMÁTICO: Algoritmo de cercanía activo.");
    } else {
      toast.info("👤 MODO MANUAL: Control total para el operador.");
    }
  };

  return (
    <div className={`mb-8 p-6 rounded-[2.5rem] transition-all duration-700 border-2 ${
      isAuto 
        ? "bg-slate-900 border-[#22c55e] shadow-[0_0_40px_rgba(34,197,94,0.15)]" 
        : "bg-white border-slate-100 shadow-xl"
    }`}>
      <div className="flex flex-col md:flex-row justify-between items-center gap-6">
        <div className="text-center md:text-left">
          <div className="flex items-center justify-center md:justify-start gap-3">
            <h2 className={`font-black text-2xl tracking-tighter transition-colors ${
              isAuto ? "text-white" : "text-slate-800"
            }`}>
              DESPACHO CENTRAL
            </h2>
            <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest animate-pulse ${
              isAuto ? "bg-[#22c55e] text-white" : "bg-slate-200 text-slate-500"
            }`}>
              {isAuto ? "Auto-Mode" : "Manual"}
            </span>
          </div>
          <p className={`text-sm mt-1 font-medium transition-colors ${
            isAuto ? "text-slate-400" : "text-slate-500"
          }`}>
            {isAuto 
              ? "El sistema asigna automáticamente al taxi más cercano." 
              : "Asigna unidades manualmente desde el panel de control."}
          </p>
        </div>

        {/* --- SWITCH TIPO IPHONE REFORZADO --- */}
        <div 
          onClick={toggleMode}
          className={`relative h-16 w-48 rounded-[1.8rem] p-1.5 cursor-pointer transition-all duration-500 shadow-inner ${
            isAuto ? "bg-[#22c55e]" : "bg-slate-200"
          }`}
        >
          {/* Etiquetas internas */}
          <div className="flex items-center justify-between px-6 w-full h-full font-black text-[10px] tracking-widest pointer-events-none">
            <span className={`transition-opacity duration-300 ${isAuto ? "opacity-0" : "text-slate-400"}`}>MANUAL</span>
            <span className={`transition-opacity duration-300 ${isAuto ? "text-white" : "opacity-0"}`}>AUTO</span>
          </div>
          
          {/* El Toggle circular/cuadrado */}
          <div className={`absolute top-1.5 left-1.5 h-13 w-24 rounded-[1.4rem] bg-white shadow-xl transition-all duration-500 ease-out flex items-center justify-center text-2xl ${
            isAuto ? "translate-x-[calc(100%-12px)]" : "translate-x-0"
          }`}>
            {isAuto ? "🤖" : "👤"}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DispatchControl;