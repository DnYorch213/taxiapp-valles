import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Search, MapPin, Calendar, User, CarTaxiFront } from 'lucide-react'; // Íconos para que se vea pro

// 1. Interfaz actualizada con los campos reales de tu MongoDB
interface Trip {
    _id: string;
    taxistaName: string;    // Importante: Tu JSON trae nombres
    taxistaEmail: string;
    pasajeroName: string;   // Importante: Tu JSON trae nombres
    pasajeroEmail: string;
    pickupAddress: string;  // Origen
    destinationAddress: string; // Destino
    fecha: string;
    estado: string;
    taxiNumber?: string;    // Lo agregamos ya que tu JSON lo tiene
}

const AdminHistoryPage = () => {
    // 2. Dile al useState que manejará un arreglo de tipo Trip
    const [trips, setTrips] = useState<Trip[]>([]); 
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('');

// Reemplaza tu constante API_URL por esta:
const API_URL = window.location.hostname === 'localhost' 
    ? "http://localhost:3001/api/admin/historial-viajes" 
    : "https://taxiapp-valles.onrender.com/api/admin/historial-viajes";
    useEffect(() => {
        fetchHistory();
    }, []);

    const fetchHistory = async () => {
        try {
            setLoading(true);
            const res = await axios.get<Trip[]>(API_URL); // 3. Tipar la respuesta de axios
            setTrips(res.data);
        } catch (error) {
            console.error("Error cargando historial:", error);
        } finally {
            setLoading(false);
        }
    };

  // 3. Mejora el filtro para que busque por nombre o dirección
const filteredTrips = trips.filter(trip => 
    trip.taxistaName?.toLowerCase().includes(filter.toLowerCase()) ||
    trip.pickupAddress?.toLowerCase().includes(filter.toLowerCase()) ||
    trip.destinationAddress?.toLowerCase().includes(filter.toLowerCase())
);

    return (
        <div className="min-h-screen bg-slate-50 p-4 md:p-8">
            <div className="max-w-6xl mx-auto">
                {/* Encabezado */}
                <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
                    <div>
                        <h1 className="text-3xl font-bold text-slate-800">Historial de Valles Conecta</h1>
                        <p className="text-slate-500">Gestión y control de servicios finalizados</p>
                    </div>
                    
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
                        <input 
                            type="text"
                            placeholder="Buscar taxista o dirección..."
                            className="pl-10 pr-4 py-2 border border-slate-200 rounded-xl w-full md:w-80 focus:ring-2 focus:ring-green-500 outline-none transition-all"
                            onChange={(e) => setFilter(e.target.value)}
                        />
                    </div>
                </div>

                {/* Tarjetas de Resumen Rápido */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                    <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
                        <div className="flex items-center gap-4">
                            <div className="p-3 bg-green-100 rounded-lg text-green-600"><CarTaxiFront /></div>
                            <div>
                                <p className="text-sm text-slate-500 font-medium">Total Viajes</p>
                                <p className="text-2xl font-bold text-slate-800">{trips.length}</p>
                            </div>
                        </div>
                    </div>
                    {/* Aquí podrías sumar ganancias si tuvieras el campo 'precio' */}
                </div>

                {/* Tabla de Resultados */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="bg-slate-50 border-b border-slate-100">
                                    <th className="p-4 text-sm font-semibold text-slate-600">Taxista / Unidad</th>
                                    <th className="p-4 text-sm font-semibold text-slate-600">Pasajero</th>
                                    <th className="p-4 text-sm font-semibold text-slate-600">Origen (Recogida)</th>
                                    <th className="p-4 text-sm font-semibold text-slate-600">Destino Final</th>
                                    <th className="p-4 text-sm font-semibold text-slate-600">Fecha y Hora</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
    {loading ? (
        <tr><td colSpan={5} className="p-10 text-center text-slate-400">Cargando historial de Valles...</td></tr>
    ) : filteredTrips.map((trip) => (
        <tr key={trip._id} className="hover:bg-slate-50/80 transition-colors">
            {/* TAXISTA Y UNIDAD */}
            <td className="p-4">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center text-xs font-bold text-orange-600">
                        {trip.taxiNumber || "T"}
                    </div>
                    <div className="flex flex-col">
                        <span className="text-sm font-medium text-slate-700">{trip.taxistaName}</span>
                        <span className="text-[10px] text-slate-400">{trip.taxistaEmail}</span>
                    </div>
                </div>
            </td>

            {/* PASAJERO */}
            <td className="p-4 text-sm text-slate-600">
                <div className="flex items-center gap-2">
                    <User className="w-4 h-4 text-slate-400" /> 
                    <span>{trip.pasajeroName}</span>
                </div>
            </td>

            {/* ORIGEN (RECOGIDA) */}
            <td className="p-4">
                <div className="flex items-center gap-2 text-xs text-blue-700 bg-blue-50 px-3 py-1 rounded-lg border border-blue-100 max-w-[200px]">
                    <MapPin className="w-3 h-3 shrink-0" /> 
                    <span className="truncate">{trip.pickupAddress}</span>
                </div>
            </td>

            {/* DESTINO FINAL */}
            <td className="p-4">
                <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 px-3 py-1 rounded-lg border border-green-100 max-w-[200px]">
                    <CarTaxiFront className="w-3 h-3 shrink-0" /> 
                    <span className="truncate">{trip.destinationAddress}</span>
                </div>
            </td>

            {/* FECHA Y HORA */}
            <td className="p-4 text-sm text-slate-500 text-right">
                <div className="flex flex-col items-end">
                    <span className="font-medium text-slate-700">
                        {new Date(trip.fecha).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                    </span>
                    <span className="text-xs">
                        {new Date(trip.fecha).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                </div>
            </td>
        </tr>
    ))}
</tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AdminHistoryPage;