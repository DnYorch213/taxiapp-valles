import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Search, MapPin, Calendar, User, CarTaxiFront } from 'lucide-react'; // Íconos para que se vea pro

// 1. Define la estructura de tu viaje
interface Trip {
    _id: string;
    driverEmail: string;
    passengerEmail: string;
    destinationAddress: string;
    endDate: string | Date;
}

const AdminHistoryPage = () => {
    // 2. Dile al useState que manejará un arreglo de tipo Trip
    const [trips, setTrips] = useState<Trip[]>([]); 
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('');

    const API_URL = "https://taxiapp-valles.onrender.com/api/admin/historial-viajes";

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

    // Filtrar por email del taxista o nombre del pasajero
    const filteredTrips = trips.filter(trip => 
        trip.driverEmail.toLowerCase().includes(filter.toLowerCase()) ||
        trip.destinationAddress.toLowerCase().includes(filter.toLowerCase())
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
                                    <th className="p-4 text-sm font-semibold text-slate-600">Destino Final</th>
                                    <th className="p-4 text-sm font-semibold text-slate-600">Fecha y Hora</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {loading ? (
                                    <tr><td colSpan={4} className="p-10 text-center text-slate-400">Cargando historial de Valles...</td></tr>
                                ) : filteredTrips.map((trip) => (
                                    <tr key={trip._id} className="hover:bg-slate-50/80 transition-colors">
                                        <td className="p-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-bold text-slate-600">
                                                    {trip.driverEmail[0].toUpperCase()}
                                                </div>
                                                <span className="text-sm font-medium text-slate-700">{trip.driverEmail}</span>
                                            </div>
                                        </td>
                                        <td className="p-4 text-sm text-slate-600">
                                            <div className="flex items-center gap-2">
                                                <User className="w-4 h-4" /> {trip.passengerEmail}
                                            </div>
                                        </td>
                                        <td className="p-4">
                                            <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 px-3 py-1 rounded-full w-fit border border-green-100">
                                                <MapPin className="w-3 h-3" /> {trip.destinationAddress}
                                            </div>
                                        </td>
                                        <td className="p-4 text-sm text-slate-500">
                                            <div className="flex items-center gap-2">
                                                <Calendar className="w-4 h-4" />
                                                {new Date(trip.endDate).toLocaleString('es-MX', {
                                                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                                                })}
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