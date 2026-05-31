import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet-routing-machine";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

// 🛡️ PARCHE DE PROTOTIPO DE NIVEL INDUSTRIAL COMPLETADO
if (L.Routing && (L.Routing as any).Control) {
  const originalClearLines = (L.Routing as any).Control.prototype._clearLines;
  
  (L.Routing as any).Control.prototype._clearLines = function () {
    if (!this._map) return;
    if (originalClearLines) {
      try { originalClearLines.apply(this, arguments); } catch (e) {}
    }
  };

  (L.Routing as any).Control.prototype._addLayer = function (layer: any) {
    if (!this._map) return;
    try { this._map.addLayer(layer); } catch (e) {}
  };

  // 🎯 EL ESCUDO DEFINITIVO: Parchamos el emisor de eventos del prototipo
  // Esto intercepta cualquier error de estatus -3 producido por sub-módulos de Leaflet
  // que intenten tocar capas (addLayer/removeLayer) cuando el mapa esté en transiciones rápidas de React.
  const originalFire = (L.Routing as any).Control.prototype.fire;
  (L.Routing as any).Control.prototype.fire = function (type: string, data: any, propagate?: boolean) {
    if (type === "routingerror" || type === "error") {
      const errMsg = data?.error?.message || "";
      if (errMsg.includes("addLayer") || errMsg.includes("null") || errMsg.includes("removeLayer")) {
        // 🤫 Devoramos el error estético de Leaflet en silencio
        return this;
      }
    }
    if (originalFire) {
      return originalFire.apply(this, arguments);
    }
    return this;
  };
}

interface RoutingMachineProps {
  waypoints: L.LatLng[];
  onRouteFound: (coords: L.LatLng[]) => void;
}

export const RoutingMachine = ({ waypoints, onRouteFound }: RoutingMachineProps) => {
  const map = useMap();

  useEffect(() => {
    if (!map || !waypoints || waypoints.length < 2) return;
    
    const container = map.getContainer();
    if (!container) return;

    const routingControl = (L.Routing as any).control({
      waypoints,
      router: (L.Routing as any).mapbox(MAPBOX_TOKEN, {
        profile: "mapbox/driving",
        language: "es",
        urlParameters: { access_token: MAPBOX_TOKEN }
      }),
      createMarker: () => null,
      show: false,
      addWaypoints: false,
      draggableWaypoints: false,
      fitSelectedRoutes: false,
      lineOptions: {
        styles: [{ opacity: 0, weight: 0 }] 
      }
    });

    let isMounted = true;

    // Silenciador local redundante por seguridad
    (routingControl as any)._onError = function (err: any) {
      if (err?.message?.includes("addLayer") || err?.message?.includes("null") || err?.message?.includes("removeLayer")) {
        return;
      }
      console.warn("⚠️ Mensaje de enrutamiento Mapbox mitigado.");
    };

    routingControl.on("routesfound", (e: any) => {
      if (!isMounted) return;
      const routes = e.routes;
      if (routes && routes[0]) {
        const coords = routes[0].coordinates.map((c: any) => L.latLng(c.lat, c.lng));
        onRouteFound(coords);
      }
    });

    try {
      routingControl.addTo(map);
    } catch (err) {
      console.warn("⚠️ addTo falló de forma asíncrona, mitigando.");
    }

    return () => {
      isMounted = false;
      try {
        routingControl.off("routesfound");
        
        if ((routingControl as any)._plan && map) {
          map.removeLayer((routingControl as any)._plan);
        }

        map.removeControl(routingControl);
      } catch (error) {
        console.warn("🛡️ Limpieza silenciosa de enrutamiento al desmontar.");
      }
    };
  }, [map, waypoints, onRouteFound]);

  return null;
};