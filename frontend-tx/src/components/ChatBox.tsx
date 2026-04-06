import React, { useState, useEffect, useRef } from 'react';
import { socket } from '../lib/socket';

interface Message {
  senderName: string;
  message: string;
  timestamp: string;
}

interface ChatBoxProps {
  toEmail: string;
  userName: string;
}

export const ChatBox: React.FC<ChatBoxProps> = ({ toEmail, userName }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll al recibir o enviar mensajes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

 useEffect(() => {
    socket.on("receive_message", (data: any) => { 
      // El servidor manda 'fromName', pero tu interfaz usa 'senderName'
      // Aquí hacemos la magia para que coincidan
      setMessages((prev) => [...prev, {
        senderName: data.fromName, // <--- Importante: mapeamos el nombre
        message: data.message,
        timestamp: data.timestamp || new Date().toISOString()
      }]);
      
      if ("vibrate" in navigator) navigator.vibrate(100);
    });

    return () => { 
      socket.off("receive_message"); 
    };
  }, []);

  const enviar = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

const payload = { 
    toEmail, 
    message: text, 
    fromName: userName // <--- Aquí ya viaja "Taxi ECO-042"
  };    socket.emit("send_message", payload);

    setMessages((prev) => [...prev, { 
      senderName: "Yo", 
      message: text, 
      timestamp: new Date().toISOString() 
    }]);
    setText("");
  };

 return (
  /* Cambiamos bg-white por bg-transparent para que mande el fondo del padre (el azul oscuro) */
  <div className="flex flex-col h-full bg-transparent overflow-hidden">
    
    {/* 🟢 ÁREA DE MENSAJES */}
    <div 
      ref={scrollRef}
      /* Fondo sutilmente oscuro para el área de mensajes */
      className="flex-1 p-4 overflow-y-auto space-y-4 bg-slate-900/20 scroll-smooth"
    >
      {messages.map((m, i) => {
        const esMio = m.senderName === "Yo";
        return (
          <div key={i} className={`flex flex-col ${esMio ? "items-end" : "items-start"} animate-in slide-in-from-bottom-2`}>
            <span className="text-[9px] text-slate-500 font-black uppercase tracking-widest mb-1 px-2">
              {esMio ? "Tú" : m.senderName}
            </span>
            <div className={`px-4 py-2.5 rounded-[1.5rem] max-w-[85%] text-sm font-medium shadow-sm transition-all ${
              esMio 
                ? "bg-[#22c55e] text-[#0f172a] rounded-tr-none font-bold" 
                : "bg-slate-800 text-white border border-white/5 rounded-tl-none"
            }`}>
              {m.message}
            </div>
          </div>
        );
      })}
    </div>

    {/* 🟢 FORMULARIO DE ENVÍO (Ajustado para modo oscuro) */}
    <form 
      onSubmit={enviar} 
      className="p-4 bg-[#1e293b] border-t border-white/5 flex gap-2 items-center"
    >
      <input 
        type="text" 
        value={text} 
        onChange={(e) => setText(e.target.value)}
        placeholder="Escribe un mensaje..."
        /* CLAVE: text-white para que se vea lo que escribes 
           bg-slate-900 para que el fondo del input sea más oscuro que el contenedor
        */
        className="flex-1 bg-slate-900 border-white/10 rounded-2xl px-5 py-3 text-sm text-white focus:ring-2 focus:ring-[#22c55e]/50 transition-all placeholder:text-slate-500 outline-none"
      />
      <button 
        type="submit"
        className="bg-[#22c55e] hover:bg-[#16a34a] text-[#0f172a] h-11 w-11 rounded-2xl flex items-center justify-center shadow-lg shadow-green-900/40 transition-all active:scale-90"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      </button>
    </form>
  </div>
);
};