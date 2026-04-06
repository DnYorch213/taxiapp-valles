import L from "leaflet";
import "leaflet-routing-machine";
import { createControlComponent } from "@react-leaflet/core";

// 🔑 Tu Token de Mapbox
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

const createRoutingMachineLayer = (props: any) => {
  const { waypoints } = props;
  
  // 🚩 VALIDACIÓN EXTRA: Verifica que los puntos tengan lat y lng válidos
  if (!waypoints || waypoints.length < 2 || !waypoints[0]?.lat) {
    return null;
  }

  // Convertimos a objetos de Leaflet reales por si acaso vienen como JSON plano
  const validWaypoints = waypoints.map((wp: any) => L.latLng(wp.lat, wp.lng));

  const instance = (L.Routing as any).control({
  waypoints: validWaypoints, // Usamos los puntos convertidos
  router: (L.Routing as any).mapbox(MAPBOX_TOKEN, {
  profile: 'mapbox/driving',
  language: 'es',
  // Fuerza a que la comunicación sea por HTTPS
 urlParameters: {
    access_token: MAPBOX_TOKEN
  }
}),
    
    // 1. Quitamos los marcadores azules de Leaflet
    createMarker: () => null, 
    
    // 2. Limpieza Total del panel de direcciones
    show: false,
    addWaypoints: false,
    draggableWaypoints: false,
    fitSelectedRoutes: true,
    // Forzamos clases que no existan para que no dibuje el cuadro blanco
    containerClassName: 'hidden-routing-container',
    itineraryClassName: 'hidden-itinerary',

    lineOptions: {
      styles: [
        { color: "#0f172a", weight: 9, opacity: 0.2 }, // Sombra sutil para mapa claro
        { color: "#22c55e", weight: 6, opacity: 1 }    // Verde neón
      ],
      extendToWaypoints: true,
      missingRouteTolerance: 10
    },
  });

  return instance;
};

// Exportamos usando 'any' para evitar conflictos con el core de React-Leaflet
export const RoutingMachine = createControlComponent<any, any>(
  createRoutingMachineLayer
);