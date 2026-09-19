import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet-routing-machine";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

// 🛡️ PARCHE DE PROTOTIPO
if (L.Routing && (L.Routing as any).Control) {
  const originalClearLines = (L.Routing as any).Control.prototype._clearLines;

  (L.Routing as any).Control.prototype._clearLines = function () {
    if (!this._map) return;

    if (originalClearLines) {
      try {
        originalClearLines.apply(this, arguments);
      } catch (e) {}
    }
  };

  (L.Routing as any).Control.prototype._addLayer = function (layer: any) {
    if (!this._map) return;

    try {
      this._map.addLayer(layer);
    } catch (e) {}
  };

  const originalFire = (L.Routing as any).Control.prototype.fire;

  (L.Routing as any).Control.prototype.fire = function (
    type: string,
    data: any,
    propagate?: boolean
  ) {
    if (type === "routingerror" || type === "error") {
      const errMsg = data?.error?.message || "";

      if (
        errMsg.includes("addLayer") ||
        errMsg.includes("null") ||
        errMsg.includes("removeLayer")
      ) {
        return this;
      }
    }

    if (originalFire) {
      return originalFire.apply(this, arguments);
    }

    return this;
  };
}

interface RouteResult {
  coords: L.LatLng[];
  distanceKm: number | null;
  durationMin: number | null;
}

interface RoutingMachineProps {
  waypoints: L.LatLng[];
  onRouteFound: (route: RouteResult) => void;
}

export const RoutingMachine = ({
  waypoints,
  onRouteFound,
}: RoutingMachineProps) => {
  const map = useMap();

  useEffect(() => {
    if (!map || !waypoints || waypoints.length < 2) return;

    const container = map.getContainer();

    if (!container) return;

    if (!MAPBOX_TOKEN) {
      console.error("❌ VITE_MAPBOX_TOKEN no está configurado.");
      return;
    }

    const routingControl = (L.Routing as any).control({
      waypoints,

      router: (L.Routing as any).mapbox(MAPBOX_TOKEN, {
        profile: "mapbox/driving",
        language: "es",
        urlParameters: {
          access_token: MAPBOX_TOKEN,
          overview: "full",
          geometries: "geojson",
        },
      }),

      createMarker: () => null,
      show: false,
      addWaypoints: false,
      draggableWaypoints: false,
      fitSelectedRoutes: false,

      lineOptions: {
        styles: [
          {
            opacity: 0,
            weight: 0,
          },
        ],
      },
    });

    let isMounted = true;

    (routingControl as any)._onError = function (err: any) {
      if (
        err?.message?.includes("addLayer") ||
        err?.message?.includes("null") ||
        err?.message?.includes("removeLayer")
      ) {
        return;
      }

      console.warn("⚠️ Mensaje de enrutamiento Mapbox mitigado:", err);
    };

    routingControl.on("routesfound", (e: any) => {
      if (!isMounted) return;

      const routes = e?.routes;

      if (!routes || !routes[0]) {
        console.warn("⚠️ Mapbox no devolvió ninguna ruta.");
        return;
      }

      const route = routes[0];

      // 🗺️ COORDENADAS
      const coords = Array.isArray(route.coordinates)
        ? route.coordinates.map((c: any) => L.latLng(c.lat, c.lng))
        : [];

      // 📏 DISTANCIA
      //
      // Leaflet Routing Machine normalmente entrega:
      // route.summary.totalDistance
      //
      // Algunas versiones/adaptadores también pueden entregar:
      // route.distance
      //
      const rawDistance =
        typeof route.distance === "number"
          ? route.distance
          : typeof route.summary?.totalDistance === "number"
          ? route.summary.totalDistance
          : typeof route.totalDistance === "number"
          ? route.totalDistance
          : null;

      // ⏱️ DURACIÓN
      //
      // Preferimos:
      // route.summary.totalTime
      //
      // y dejamos route.duration como fallback.
      const rawDuration =
        typeof route.duration === "number"
          ? route.duration
          : typeof route.summary?.totalTime === "number"
          ? route.summary.totalTime
          : typeof route.totalTime === "number"
          ? route.totalTime
          : null;

      const distanceKm =
        typeof rawDistance === "number"
          ? rawDistance / 1000
          : null;

      const durationMin =
        typeof rawDuration === "number"
          ? rawDuration / 60
          : null;

      console.log("🗺️ Ruta Mapbox COMPLETA:", route);

      console.log("📏 DATOS VIALES MAPBOX:", {
        rawDistance,
        rawDuration,
        distanceKm,
        durationMin,
        puntos: coords.length,
      });

      if (distanceKm === null || durationMin === null) {
        console.warn(
          "⚠️ Mapbox devolvió la geometría pero no se encontró distancia/duración.",
          {
            route,
            summary: route.summary,
          }
        );
      }

      onRouteFound({
        coords,
        distanceKm,
        durationMin,
      });
    });

    routingControl.on("routingerror", (e: any) => {
      console.error("❌ Error de routing Mapbox:", e);
    });

    try {
      routingControl.addTo(map);
    } catch (err) {
      console.warn(
        "⚠️ addTo falló de forma asíncrona, mitigando.",
        err
      );
    }

    return () => {
      isMounted = false;

      try {
        routingControl.off("routesfound");
        routingControl.off("routingerror");

        if ((routingControl as any)._plan && map) {
          map.removeLayer((routingControl as any)._plan);
        }

        map.removeControl(routingControl);
      } catch (error) {
        console.warn(
          "🛡️ Limpieza silenciosa de enrutamiento al desmontar.",
          error
        );
      }
    };
  }, [map, waypoints, onRouteFound]);

  return null;
};