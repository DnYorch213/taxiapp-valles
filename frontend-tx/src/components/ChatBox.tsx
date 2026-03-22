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
    socket.on("receive_message", (data: Message) => {
      setMessages((prev) => [...prev, data]);
      if ("vibrate" in navigator) navigator.vibrate(100);
    });

    return () => { socket.off("receive_message"); };
  }, []);

  const enviar = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    const newMessage = { toEmail, message: text, senderName: userName };
    socket.emit("send_message", newMessage);

    setMessages((prev) => [...prev, { 
      senderName: "Yo", 
      message: text, 
      timestamp: new Date().toISOString() 
    }]);
    setText("");
  };

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden">
      {/* 🟢 ÁREA DE MENSAJES */}
      <div 
        ref={scrollRef}
        className="flex-1 p-4 overflow-y-auto space-y-4 bg-slate-50/50 scroll-smooth"
      >
        {messages.map((m, i) => {
          const esMio = m.senderName === "Yo";
          return (
            <div key={i} className={`flex flex-col ${esMio ? "items-end" : "items-start"} animate-in slide-in-from-bottom-2`}>
              <span className="text-[9px] text-slate-400 font-black uppercase tracking-widest mb-1 px-2">
                {esMio ? "Tú" : m.senderName}
              </span>
              <div className={`px-4 py-2.5 rounded-[1.5rem] max-w-[85%] text-sm font-medium shadow-sm transition-all ${
                esMio 
                  ? "bg-[#22c55e] text-white rounded-tr-none" 
                  : "bg-white text-slate-700 border border-slate-100 rounded-tl-none"
              }`}>
                {m.message}
              </div>
            </div>
          );
        })}
      </div>

      {/* 🟢 FORMULARIO DE ENVÍO (Estilo Pill) */}
      <form onSubmit={enviar} className="p-4 bg-white border-t border-slate-100 flex gap-2 items-center">
        <input 
          type="text" 
          value={text} 
          onChange={(e) => setText(e.target.value)}
          placeholder="Escribe un mensaje..."
          className="flex-1 bg-slate-100 border-none rounded-2xl px-5 py-3 text-sm focus:ring-2 focus:ring-[#22c55e]/20 transition-all placeholder:text-slate-400"
        />
        <button 
          type="submit"
          className="bg-[#22c55e] hover:bg-[#16a34a] text-white h-11 w-11 rounded-2xl flex items-center justify-center shadow-lg shadow-green-200 transition-all active:scale-90"
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