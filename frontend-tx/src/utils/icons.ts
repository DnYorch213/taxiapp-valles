import L from "leaflet";

// 📍 Ícono del pasajero
export const pasajeroIcon = L.icon({
  iconUrl: "/icons/pasajero.png", // asegúrate de tener esta imagen en public/icons/
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
  className: "leaflet-pasajero-icon",
});

// 🎯 Ícono del destino
export const destinoIcon = L.icon({
  iconUrl: "/icons/destino.png", // asegúrate de tener esta imagen en public/icons/
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
  className: "leaflet-destino-icon",
});
// 🚖 Ícono del taxista
export const taxistaIcon = L.icon({
  iconUrl: "/icons/taxista.png", // asegúrate de tener esta imagen en public/icons/
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
  className: "leaflet-taxista-icon",
});
