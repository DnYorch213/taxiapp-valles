import React, { useState, useEffect } from "react";
import { socket } from "../lib/socket";

const PanelSolicitudes: React.FC = () => {
  const [viajes, setViajes] = useState<any[]>([]);

  useEffect(() => {
    socket.on("panel_update", (data) => {
      setViajes((prev) => [
        ...prev,
        {
          pasajeroEmail: data.pasajeroEmail,
          taxistaEmail: data.taxistaEmail,
          pickupAddress: data.pickupAddress,
          estado: data.estado,
          role: data.role,
          timestamp: data.timestamp,
        },
      ]);
    });

    socket.on("trip_cancelled_panel", ({ pasajeroEmail, taxistaEmail }) => {
      setViajes((prev) =>
        prev.map((v) =>
          v.pasajeroEmail === pasajeroEmail && v.taxistaEmail === taxistaEmail
            ? { ...v, estado: "cancelado" }
            : v
        )
      );
    });

    return () => {
      socket.off("panel_update");
      socket.off("trip_cancelled_panel");
    };
  }, []);

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">📊 Panel de solicitudes</h2>
      <table className="w-full border-collapse border border-gray-300">
     <thead>
  <tr>
    <th>Pasajero</th>
    <th>Taxista</th>
    <th>Rol</th>
    <th>Dirección</th>
    <th>Estado</th>
    <th>Hora</th>
  </tr>
</thead>
<tbody>
  {viajes.map((v, i) => (
    <tr key={i}>
      <td>{v.pasajeroEmail}</td>
      <td>{v.taxistaEmail || "-"}</td>
      <td>{v.role}</td>
      <td>{v.pickupAddress || "-"}</td>
      <td>{v.estado}</td>
      <td>{new Date(v.timestamp).toLocaleTimeString()}</td>
    </tr>
  ))}
</tbody>
</table>
</div>
);
};

export default PanelSolicitudes;
