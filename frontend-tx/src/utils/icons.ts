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

// 📍 Ícono del pasajero
/* export const pasajeroIcon = L.icon({
  iconUrl: "/icons/pasajero.png", // asegúrate de tener esta imagen en public/icons/
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
  className: "leaflet-pasajero-icon",
}); */

// 🚖 Ícono del taxista
export const taxistaIcon = L.icon({
  iconUrl: "/icons/taxista.png", // asegúrate de tener esta imagen en public/icons/
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
  className: "taxi-orientado",
});
