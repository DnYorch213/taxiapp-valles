export interface FareDestination {
  name: string;
  lat: number;
  lng: number;
  fixedPrice?: number;
  pricePerKm?: number;
  minPrice?: number;
}

export const FARE_TABLE: FareDestination[] = [
  { name: "Fracc. Sn. Rafael - Zona Centro", lat: 21.9915, lng: -98.9925, fixedPrice: 80 },
  { name: "Central Camionera", lat: 21.985, lng: -98.995, fixedPrice: 80 },
  { name: "Hospital", lat: 21.978, lng: -99.005, fixedPrice: 90 },
  { name: "UASLP", lat: 22.0, lng: -99.01, fixedPrice: 70 },
  { name: "Cuartel", lat: 21.99, lng: -98.985, fixedPrice: 75 },
  { name: "Panteón", lat: 21.98, lng: -98.99, fixedPrice: 75 },
  { name: "MP", lat: 21.995, lng: -99.0, fixedPrice: 90 },
  { name: "Auto Park", lat: 21.992, lng: -98.988, fixedPrice: 80 },
  { name: "Lomas de Santiago", lat: 22.01, lng: -98.995, fixedPrice: 80 },
  { name: "Las Huastecas", lat: 22.005, lng: -99.01, fixedPrice: 90 },
  { name: "Gavilán", lat: 22.0, lng: -98.985, fixedPrice: 90 },
  { name: "Bicentenario", lat: 21.975, lng: -98.98, fixedPrice: 100 },
  { name: "Walmart", lat: 21.99, lng: -99.015, fixedPrice: 75 },
  { name: "Centro Cultural", lat: 21.993, lng: -98.99, fixedPrice: 75 },
  { name: "Lomas del Yuejat", lat: 22.008, lng: -99.0, fixedPrice: 80 },
  { name: "Secundaria", lat: 21.988, lng: -98.992, fixedPrice: 75 },
  { name: "Glorieta Hidalgo", lat: 21.992, lng: -98.985, fixedPrice: 70 },
  { name: "Col. Obrera", lat: 21.985, lng: -98.992, fixedPrice: 80 },
  { name: "Col. Altavista", lat: 21.995, lng: -99.005, fixedPrice: 80 },
  { name: "ISSSTE", lat: 21.99, lng: -99.008, fixedPrice: 80 },
  { name: "INE", lat: 21.998, lng: -99.01, fixedPrice: 80 },
  { name: "Chedraui", lat: 22.002, lng: -99.02, fixedPrice: 90 },
  { name: "Col. Juarez", lat: 21.978, lng: -98.985, fixedPrice: 100 },
  { name: "Sec. PAS", lat: 21.975, lng: -99.02, fixedPrice: 90 },
  { name: "Glorieta PAS", lat: 21.97, lng: -99.025, fixedPrice: 90 },
  { name: "Col. Doracely", lat: 21.97, lng: -99.01, fixedPrice: 90 },
  { name: "IMSS", lat: 21.992, lng: -99.003, fixedPrice: 80 },
  { name: "Carmen 1", lat: 21.991, lng: -98.995, fixedPrice: 80 },
  { name: "Carmen 2", lat: 21.99, lng: -98.999, fixedPrice: 80 },
  { name: "Carmen 3", lat: 21.989, lng: -99.003, fixedPrice: 90 },
  { name: "Pimienta 1era Secc.", lat: 21.982, lng: -99.015, fixedPrice: 90 },
  { name: "Pimienta 2da. Secc.", lat: 21.978, lng: -99.02, fixedPrice: 100 },
  { name: "Colonial", lat: 21.993, lng: -99.012, fixedPrice: 85 },
  { name: "Soriana Valle Alto", lat: 21.994, lng: -99.018, fixedPrice: 85 },
  { name: "Col. 18 de Marzo", lat: 21.976, lng: -99.01, fixedPrice: 90 },
  { name: "Sec. 3", lat: 21.97, lng: -99.03, fixedPrice: 100 },
  { name: "Cobach 06", lat: 21.968, lng: -99.032, fixedPrice: 100 },
  { name: "Cobach 24", lat: 21.995, lng: -98.982, fixedPrice: 70 },
  { name: "Praderas", lat: 22.02, lng: -99.04, fixedPrice: 140 },
  { name: "Pancho Villa", lat: 22.015, lng: -99.035, fixedPrice: 110 },
  { name: "Vista Hermosa", lat: 22.025, lng: -99.045, fixedPrice: 120 },
  { name: "UNEME", lat: 21.993, lng: -99.002, fixedPrice: 80 },
  { name: "Oxxo Alameda", lat: 21.992, lng: -98.995, fixedPrice: 100 },
  { name: "Icess", lat: 21.9915, lng: -98.993, fixedPrice: 50 },
  { name: "Cbtis 46", lat: 21.991, lng: -98.994, fixedPrice: 50 },
  { name: "San Angel 1", lat: 21.9905, lng: -98.993, fixedPrice: 65 },
  { name: "San Angel 2", lat: 21.99, lng: -98.992, fixedPrice: 65 },
  { name: "San José Icess", lat: 21.9908, lng: -98.9935, fixedPrice: 65 },
  { name: "Estadio", lat: 21.9895, lng: -98.994, fixedPrice: 50 },
];

export const BASE_FARE = 70;
