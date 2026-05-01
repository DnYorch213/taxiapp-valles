import L from "leaflet";
import "leaflet-routing-machine";
import { createControlComponent } from "@react-leaflet/core";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

const createRoutingMachineLayer = (props: any) => {
  const { waypoints } = props;

  if (!waypoints || waypoints.length < 2 || !waypoints[0]?.lat) {
    return (L as any).Layer(); // Retorna una capa vacía segura
  }

  const validWaypoints = waypoints.map((wp: any) => L.latLng(wp.lat, wp.lng));

  const instance = (L.Routing as any).control({
    waypoints: validWaypoints,
    router: (L.Routing as any).mapbox(MAPBOX_TOKEN, {
      profile: 'mapbox/driving',
      language: 'es',
      urlParameters: { access_token: MAPBOX_TOKEN }
    }),
    createMarker: () => null,
    show: false,
    addWaypoints: false,
    draggableWaypoints: false,
    fitSelectedRoutes: false, // Evita saltos de cámara molestos
    containerClassName: 'hidden-routing-container',
    lineOptions: {
      styles: [
        { color: "#0f172a", weight: 9, opacity: 0.2 },
        { color: "#22c55e", weight: 6, opacity: 1 }
      ],
      extendToWaypoints: true,
      missingRouteTolerance: 10
    },
  });

  return instance;
};

// 🚩 SOLUCIÓN AL ERROR:
// Definimos el componente con un solo argumento
export const RoutingMachine = createControlComponent<any, any>(
  createRoutingMachineLayer
);

/**
 * EXPLICACIÓN:
 * Aunque eliminamos el segundo argumento para quitar el error de TS, 
 * React-Leaflet por defecto destruye y recrea el control cuando las props cambian.
 * Al tener 'fitSelectedRoutes: false', la experiencia será fluida porque el mapa
 * no saltará, solo se redibujará la línea en la nueva posición del taxista.
 */