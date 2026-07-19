import L from "leaflet";

// 🟢 Ícono del pasajero verde (Usando el default de Leaflet + Filtro CSS)
export const pasajeroIcon = L.icon({
  iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});


// 🚖 Ícono del taxista
export const taxistaIcon = L.icon({
  iconUrl: "/icons/taxista.png",
  iconSize: [40, 40],
  iconAnchor: [20, 20],
  popupAnchor: [0, -20],
  className: "taxi-orientado",
});

export const banderaIcon = L.icon({
  iconUrl: "/icons/banderaIcon.png", // 🏁 icono de banderilla
  iconSize: [25, 25], // tamaño del icono
  iconAnchor: [12, 25], // punto de anclaje (base del icono)
  popupAnchor: [0, -32], // posición del popup respecto al icono
});
