import { useEffect, useRef } from "react";
import { Marker, MarkerProps } from "react-leaflet";
import L from "leaflet";

interface RotatedMarkerProps extends MarkerProps {
  rotationAngle?: number;
}

const RotatedMarker = ({ rotationAngle = 0, ...props }: RotatedMarkerProps) => {
  const markerRef = useRef<L.Marker>(null);

  // 🎯 EFECTO 1: Aplicar las propiedades base una sola vez cuando el elemento nace
  useEffect(() => {
    const marker = markerRef.current;
    if (marker) {
      const element = marker.getElement();
      if (element) {
        element.style.transformOrigin = "center";
        element.style.transition = "transform 0.3s ease-out"; // Desplazamiento suave
      }
    }
  }, []); // Vacío para que solo se ejecute al montar el marcador

  // 🎯 EFECTO 2: Manejo de la rotación mediante manipulación directa y segura
  useEffect(() => {
    const marker = markerRef.current;
    if (marker) {
      const element = marker.getElement();
      if (element) {
        // En lugar de machacar todo el transform, le inyectamos una propiedad CSS o
        // filtramos el string de manera que se actualice de forma síncrona.
        const updateRotation = () => {
          const currentTransform = element.style.transform || "";
          const baseTransform = currentTransform.replace(/rotate\([^)]*\)/, "").trim();
          element.style.transform = `${baseTransform} rotate(${rotationAngle}deg)`;
        };

        // Ejecutamos de inmediato
        updateRotation();

        // 🛡️ EL ESCUDO: Escuchamos el evento nativo de Leaflet cuando el mapa se redibuja (zoom/pan)
        // para volver a clavar la rotación antes de que la pantalla parpadee.
        marker.on("add", updateRotation);
        return () => {
          marker.off("add", updateRotation);
        };
      }
    }
  }, [rotationAngle, props.position]); // 🎯 Agregamos la posición para que se recalcule al avanzar

  return <Marker ref={markerRef} {...props} />;
};

export default RotatedMarker;