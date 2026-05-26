import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet-routing-machine";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

interface RoutingMachineProps {
  waypoints: L.LatLng[];
  onRouteFound: (coords: L.LatLng[]) => void;
}

export const RoutingMachine = ({ waypoints, onRouteFound }: RoutingMachineProps) => {
  const map = useMap();

  useEffect(() => {
    if (!map || !waypoints || waypoints.length < 2) return;

    // 🎯 Creamos la instancia del router de Mapbox de forma silenciosa y ligera
    const routingControl = (L.Routing as any).control({
      waypoints: waypoints,
      router: (L.Routing as any).mapbox(MAPBOX_TOKEN, {
        profile: "mapbox/driving",
        language: "es",
        urlParameters: { access_token: MAPBOX_TOKEN }
      }),
      createMarker: () => null, // No creamos marcadores basura en el mapa
      show: false,
      addWaypoints: false,
      draggableWaypoints: false,
      fitSelectedRoutes: false,
      // 🛡️ Al pasarle estilos vacíos e invisibles, Leaflet NO dibuja nada en el mapa,
      // evitando conflictos de renders con tu Polyline nativa de React.
      lineOptions: {
        styles: [{ opacity: 0, weight: 0 }]
      }
    });

    // 📥 CAPTURA DE RUTA: Cuando Mapbox responde, extraemos los puntos y se los mandamos al padre
    routingControl.on("routesfound", (e: any) => {
      const routes = e.routes;
      if (routes && routes[0]) {
        const coords = routes[0].coordinates.map((c: any) => L.latLng(c.lat, c.lng));
        onRouteFound(coords); // Inyecta la geometría limpia a 'setGeometriaRuta'
      }
    });

    // Añadimos el control al mapa de forma efímera
    routingControl.addTo(map);

    // 🧼 LIMPIEZA CRÍTICA: Cuando el componente se desmonta, removemos el control
    // de forma segura sin disparar re-renders destructivos en los marcadores.
    return () => {
      try {
        map.removeControl(routingControl);
      } catch (err) {
        console.warn("⚠️ Limpieza silenciosa de enrutamiento");
      }
    };
  }, [map, waypoints, onRouteFound]);

  return null; // No renderiza HTML innecesario, trabaja 100% en memoria
};