import L from "leaflet";
import "leaflet-routing-machine";
import { createControlComponent } from "@react-leaflet/core";

// 1. Extendemos de L.ControlOptions para que sea compatible con lo que react-leaflet espera
interface RoutingProps extends L.ControlOptions {
  waypoints: L.LatLng[];
}

const CreateRoutingMachineLayer = (props: RoutingProps) => {
  const { waypoints } = props;

  // Creamos la instancia con 'as any' para saltar las definiciones incompletas de la librería
  const instance = (L.Routing as any).control({
    waypoints,
    lineOptions: {
      styles: [{ color: "#3b82f6", weight: 6 }],
      extendToWaypoints: true,
      missingRouteTolerance: 0,
    },
    show: false,
    addWaypoints: false,
    routeWhileDragging: false,
    fitSelectedRoutes: true,
    draggableWaypoints: false,
    // Tip: Si quieres que NO aparezcan los marcadores feos de la librería (A y B)
    // descomenta la siguiente línea:
    // createMarker: () => null, 
  });

  return instance;
};

// 2. Pasamos los tipos genéricos correctos para que no haya quejas de "no properties in common"
export const RoutingMachine = createControlComponent<any, RoutingProps>(
  CreateRoutingMachineLayer
);