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
        // Aquí ocurre la magia: rotamos la imagen del taxi
        element.style.transformOrigin = "center";
        element.style.transition = "transform 0.3s ease"; // Para que gire suave
        element.style.transform += ` rotate(${rotationAngle}deg)`;
      }
    }
  }, [rotationAngle]);

  return <Marker ref={markerRef} {...props} />;
};

export default RotatedMarker;