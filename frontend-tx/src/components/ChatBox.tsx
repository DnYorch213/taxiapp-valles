import React, { useState, useEffect } from 'react';
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

  useEffect(() => {
    socket.on("receive_message", (data: Message) => {
      setMessages((prev) => [...prev, data]);
      if ("vibrate" in navigator) navigator.vibrate(100);
    });

    return () => { socket.off("receive_message"); };
  }, []);

  const enviar = (e: React.FormEvent) => {
    e.preventDefault();
    console.log("📤 Intentando enviar mensaje a:", toEmail);
    if (!text.trim()) return;

    const newMessage = { toEmail, message: text, senderName: userName };
    socket.emit("send_message", newMessage);

    // Añadir mi propio mensaje a la lista
    setMessages((prev) => [...prev, { senderName: "Yo", message: text, timestamp: new Date().toISOString() }]);
    setText("");
  };

  return (
    <div className="flex flex-col h-64 bg-slate-50 rounded-2xl border border-slate-200 overflow-hidden shadow-inner">
      <div className="flex-1 p-3 overflow-y-auto space-y-2 text-sm">
        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col ${m.senderName === "Yo" ? "items-end" : "items-start"}`}>
            <span className="text-[10px] text-slate-400 font-bold mb-1">{m.senderName}</span>
            <div className={`px-3 py-2 rounded-2xl max-w-[80%] ${
              m.senderName === "Yo" ? "bg-slate-900 text-white rounded-tr-none" : "bg-white text-slate-700 border rounded-tl-none"
            }`}>
              {m.message}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={enviar} className="p-2 bg-white border-t flex gap-2">
        <input 
          type="text" value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Escribe tu mensaje..."
          className="flex-1 bg-slate-100 border-none rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-yellow-400"
        />
        <button className="bg-yellow-400 p-2 rounded-xl text-lg">🚀</button>
      </form>
    </div>
  );
};