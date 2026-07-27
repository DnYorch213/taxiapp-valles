import { useEffect } from "react";
import { useMap } from "react-leaflet";

interface MapRotationBinderProps {
  bearing: number;
}

const stripExistingRotation = (transform: string) => transform.replace(/\srotate\([^)]*\)/g, "").trim();

export const MapRotationBinder = ({ bearing }: MapRotationBinderProps) => {
  const map = useMap();

  useEffect(() => {
    const mapPane = map.getPane("mapPane");
    if (!mapPane) return;

    const applyBearing = () => {
      const baseTransform = stripExistingRotation(mapPane.style.transform || "");
      mapPane.style.transformOrigin = "50% 50%";
      mapPane.style.transform = `${baseTransform} rotate(${bearing}deg)`;
    };

    applyBearing();
    map.on("zoom move", applyBearing);

    return () => {
      map.off("zoom move", applyBearing);
      const baseTransform = stripExistingRotation(mapPane.style.transform || "");
      mapPane.style.transform = baseTransform;
    };
  }, [map, bearing]);

  return null;
};

export default MapRotationBinder;
