import React, { useCallback, useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { toast } from "react-toastify";

const origenMarkerIcon = L.divIcon({
  className: "",
  html: `
    <div style="position:relative;width:26px;height:26px;filter:drop-shadow(0 4px 8px rgba(0,0,0,0.28));">
      <div style="position:absolute;inset:0;background:#2563eb;border:3px solid #ffffff;border-radius:9999px;"></div>
    </div>
  `,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

const destinoMarkerIcon = L.divIcon({
  className: "",
  html: `
    <div style="position:relative;width:30px;height:42px;filter:drop-shadow(0 6px 10px rgba(0,0,0,0.28));">
      <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:30px;height:30px;background:#22c55e;border:2px solid #ffffff;border-radius:50% 50% 50% 0;transform-origin:center;rotate:-45deg;"></div>
      <div style="position:absolute;left:50%;top:9px;transform:translateX(-50%);width:10px;height:10px;background:#ffffff;border-radius:9999px;"></div>
    </div>
  `,
  iconSize: [30, 42],
  iconAnchor: [15, 40],
});

type CampoActivo = "origen" | "destino";

const reverseGeocode = async (lat: number, lng: number): Promise<string> => {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("No se pudo resolver la dirección");
  const data = await response.json();
  return data.display_name || `Ubicación ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
};

const forwardGeocode = async (query: string): Promise<{ lat: number; lng: number; address: string } | null> => {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "mx");

  const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("No se pudo buscar la dirección");
  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) return null;

  const match = results[0];
  const lat = Number(match.lat);
  const lng = Number(match.lon);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  return { lat, lng, address: match.display_name || query };
};

const MapClickHandler: React.FC<{ onMapClick: (lat: number, lng: number) => void }> = ({ onMapClick }) => {
  useMapEvents({
    click: (event) => {
      onMapClick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
};

export interface TripLocationResult {
  originLat: number;
  originLng: number;
  originAddress: string;
  destinationLat: number | null;
  destinationLng: number | null;
  destinationAddress: string;
}

interface TripLocationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (result: TripLocationResult) => void;
  initialOriginLat: number;
  initialOriginLng: number;
  initialOriginAddress?: string;
  initialDestinationLat?: number | null;
  initialDestinationLng?: number | null;
  initialDestinationAddress?: string;
}

export const TripLocationModal: React.FC<TripLocationModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  initialOriginLat,
  initialOriginLng,
  initialOriginAddress = "",
  initialDestinationLat = null,
  initialDestinationLng = null,
  initialDestinationAddress = "",
}) => {
  const [campoActivo, setCampoActivo] = useState<CampoActivo>("destino");

  const [origenLat, setOrigenLat] = useState(initialOriginLat);
  const [origenLng, setOrigenLng] = useState(initialOriginLng);
  const [origenQuery, setOrigenQuery] = useState(initialOriginAddress);
  const [origenAddress, setOrigenAddress] = useState(initialOriginAddress);
  const [buscandoOrigen, setBuscandoOrigen] = useState(false);

  const [destinoLat, setDestinoLat] = useState<number | null>(initialDestinationLat);
  const [destinoLng, setDestinoLng] = useState<number | null>(initialDestinationLng);
  const [destinoQuery, setDestinoQuery] = useState(initialDestinationAddress);
  const [destinoAddress, setDestinoAddress] = useState(initialDestinationAddress);
  const [buscandoDestino, setBuscandoDestino] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setOrigenLat(initialOriginLat);
    setOrigenLng(initialOriginLng);
    setOrigenQuery(initialOriginAddress);
    setOrigenAddress(initialOriginAddress);
    setDestinoLat(initialDestinationLat);
    setDestinoLng(initialDestinationLng);
    setDestinoQuery(initialDestinationAddress);
    setDestinoAddress(initialDestinationAddress);
    setCampoActivo("destino");
  }, [isOpen, initialOriginLat, initialOriginLng, initialOriginAddress, initialDestinationLat, initialDestinationLng, initialDestinationAddress]);

  const handleMapClick = useCallback(async (lat: number, lng: number) => {
    if (campoActivo === "origen") {
      setOrigenLat(lat);
      setOrigenLng(lng);
      try {
        const address = await reverseGeocode(lat, lng);
        setOrigenAddress(address);
        setOrigenQuery(address);
      } catch {
        const label = `Ubicación ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        setOrigenAddress(label);
        setOrigenQuery(label);
      }
    } else {
      setDestinoLat(lat);
      setDestinoLng(lng);
      try {
        const address = await reverseGeocode(lat, lng);
        setDestinoAddress(address);
        setDestinoQuery(address);
      } catch {
        const label = `Ubicación ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        setDestinoAddress(label);
        setDestinoQuery(label);
      }
    }
  }, [campoActivo]);

  const buscarOrigen = useCallback(async () => {
    const query = origenQuery.trim();
    if (!query) {
      toast.error("Escribe una dirección de origen primero.");
      return;
    }
    setBuscandoOrigen(true);
    try {
      const match = await forwardGeocode(query);
      if (!match) {
        toast.error("No encontré esa dirección. Prueba con otra.");
        return;
      }
      setOrigenLat(match.lat);
      setOrigenLng(match.lng);
      setOrigenAddress(match.address);
      setOrigenQuery(match.address);
    } catch {
      toast.error("No pude buscar el origen en este momento.");
    } finally {
      setBuscandoOrigen(false);
    }
  }, [origenQuery]);

  const buscarDestino = useCallback(async () => {
    const query = destinoQuery.trim();
    if (!query) {
      toast.error("Escribe un destino primero.");
      return;
    }
    setBuscandoDestino(true);
    try {
      const match = await forwardGeocode(query);
      if (!match) {
        toast.error("No encontré esa ubicación. Prueba con otra dirección.");
        return;
      }
      setDestinoLat(match.lat);
      setDestinoLng(match.lng);
      setDestinoAddress(match.address);
      setDestinoQuery(match.address);
    } catch {
      toast.error("No pude buscar el destino en este momento.");
    } finally {
      setBuscandoDestino(false);
    }
  }, [destinoQuery]);

  const handleConfirmar = () => {
    onConfirm({
      originLat: origenLat,
      originLng: origenLng,
      originAddress: origenAddress || origenQuery || "Origen sin especificar",
      destinationLat: destinoLat,
      destinationLng: destinoLng,
      destinationAddress: destinoAddress || destinoQuery || "",
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[2000] bg-black/50 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-md sm:rounded-3xl rounded-t-3xl bg-white flex flex-col max-h-[92vh] overflow-hidden shadow-2xl">
        <div className="px-5 pt-4 pb-2 flex items-center justify-between border-b border-slate-100">
          <div>
            <p className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-400">Valles Conecta</p>
            <h2 className="text-base font-black text-slate-900 tracking-tight">Origen y destino</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-full bg-slate-100 text-slate-500 font-black flex items-center justify-center active:scale-95"
          >
            ✕
          </button>
        </div>

        <div className="h-56 shrink-0 relative">
          <MapContainer
            center={[origenLat, origenLng]}
            zoom={16}
            style={{ height: "100%", width: "100%" }}
            zoomControl={false}
          >
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapClickHandler onMapClick={handleMapClick} />
            <Marker
              position={[origenLat, origenLng]}
              icon={origenMarkerIcon}
              draggable
              eventHandlers={{
                dragend: (event) => {
                  const marker = event.target as L.Marker;
                  const next = marker.getLatLng();
                  void handleMapClick(next.lat, next.lng).then(() => setCampoActivo("origen"));
                },
              }}
            />
            {destinoLat !== null && destinoLng !== null && (
              <Marker
                position={[destinoLat, destinoLng]}
                icon={destinoMarkerIcon}
                draggable
                eventHandlers={{
                  dragend: (event) => {
                    const marker = event.target as L.Marker;
                    const next = marker.getLatLng();
                    setCampoActivo("destino");
                    void handleMapClick(next.lat, next.lng);
                  },
                }}
              />
            )}
          </MapContainer>
          <p className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[8px] font-black uppercase tracking-widest text-white bg-slate-900/70 px-3 py-1 rounded-full pointer-events-none">
            Toca el mapa o arrastra el pin: {campoActivo === "origen" ? "origen" : "destino"}
          </p>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          <div>
            <p className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-400 mb-1">Origen</p>
            <div className="flex gap-2">
              <input
                value={origenQuery}
                onFocus={() => setCampoActivo("origen")}
                onChange={(e) => setOrigenQuery(e.target.value)}
                placeholder="¿Dónde te recogemos?"
                className="flex-1 min-w-0 bg-slate-100 border border-slate-200 rounded-xl px-3 py-3 text-sm font-medium text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/30"
              />
              <button
                type="button"
                onClick={() => { setCampoActivo("origen"); void buscarOrigen(); }}
                disabled={buscandoOrigen || !origenQuery.trim()}
                className="px-4 rounded-xl bg-blue-600 text-white font-black text-[9px] uppercase tracking-widest disabled:opacity-60 active:scale-95"
              >
                {buscandoOrigen ? "..." : "Buscar"}
              </button>
            </div>
          </div>

          <div>
            <p className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-400 mb-1">Destino</p>
            <div className="flex gap-2">
              <input
                value={destinoQuery}
                onFocus={() => setCampoActivo("destino")}
                onChange={(e) => setDestinoQuery(e.target.value)}
                placeholder="¿A dónde vamos?"
                className="flex-1 min-w-0 bg-slate-100 border border-slate-200 rounded-xl px-3 py-3 text-sm font-medium text-slate-800 outline-none focus:ring-2 focus:ring-[#22c55e]/30"
              />
              <button
                type="button"
                onClick={() => { setCampoActivo("destino"); void buscarDestino(); }}
                disabled={buscandoDestino || !destinoQuery.trim()}
                className="px-4 rounded-xl bg-[#22c55e] text-[#0f172a] font-black text-[9px] uppercase tracking-widest disabled:opacity-60 active:scale-95"
              >
                {buscandoDestino ? "..." : "Buscar"}
              </button>
            </div>
          </div>
        </div>

        <div className="p-4 pt-0 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest bg-slate-100 text-slate-500 active:scale-95"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirmar}
            className="flex-1 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest bg-[#22c55e] text-white shadow-lg shadow-green-900/20 active:scale-95"
          >
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
};
