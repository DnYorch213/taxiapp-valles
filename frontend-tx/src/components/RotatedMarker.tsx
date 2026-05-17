import { useEffect, useRef } from "react";
import { Marker, MarkerProps } from "react-leaflet";
import L from "leaflet";

interface RotatedMarkerProps extends MarkerProps {
  rotationAngle?: number;
}

const RotatedMarker = ({ rotationAngle = 0, ...props }: RotatedMarkerProps) => {
  const markerRef = useRef<L.Marker>(null);

 useEffect(() => {
  const marker = markerRef.current;
  if (marker) {
    const element = marker.getElement();
    if (element) {
      element.style.transformOrigin = "center";
      element.style.transition = "transform 0.3s ease";

      // 🚩 Tomamos el transform actual (que incluye translate)
      const currentTransform = element.style.transform || "";

      // 🚩 Eliminamos cualquier rotación previa
      const baseTransform = currentTransform.replace(/rotate\([^)]*\)/, "").trim();

      // 🚩 Aplicamos translate + nueva rotación
      element.style.transform = `${baseTransform} rotate(${rotationAngle}deg)`;
    }
  }
}, [rotationAngle]);


  return <Marker ref={markerRef} {...props} />;
};

export default RotatedMarker;