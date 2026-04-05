import L from "leaflet";
import "leaflet-routing-machine";
import { createControlComponent } from "@react-leaflet/core";

// 🔑 Tu Token de Mapbox
const MAPBOX_TOKEN = "pk.eyJ1IjoiZG55b3JjaDIxMyIsImEiOiJjbW5sMGNpcmIxM2VqMnJxNWZicWQ0OTV2In0.XIpSK6AtxAPhzH7cmszRow";

const createRoutingMachineLayer = (props: any) => {
  const { waypoints } = props;
  
  if (!waypoints || waypoints.length === 0) return null;

  // Usamos el constructor de control con un casteo directo a 'any'
  const instance = (L.Routing as any).control({
    waypoints: waypoints,
    router: (L.Routing as any).mapbox(MAPBOX_TOKEN, {
      profile: 'mapbox/driving',
      language: 'es',
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