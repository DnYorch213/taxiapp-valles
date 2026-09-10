import { calculateDistance } from "../utils/distance";

export interface FareEstimate {
  distanceKm: number;
  estimatedPrice: number;
}

// 1. TABLA DE TRAMOS
const FARE_TIERS = [
  { maxKm: 0.5, price: 50 },
  { maxKm: 1.4, price: 65 },
  { maxKm: 1.9, price: 70 },
  { maxKm: 2.4, price: 75 },
  { maxKm: 3.0, price: 80 },
  { maxKm: 3.9, price: 90 },
  { maxKm: 4.9, price: 100 },
  { maxKm: 5.9, price: 105 },
];

// 2. LUGARES CON PRECIO ESPECIAL
const KNOWN_LOCATIONS: Record<string, number> = {
  "soriana valle alto": 85,
  "colonial": 85,
  "central camionera": 80,
  "walmart": 75,
  "chedraui": 90,
  "uasl": 70,
  "hospital": 90,
  "pancho villa": 110,
  "praderas": 140,
  "vista hermosa": 120
};

/**
 * Calcula la tarifa estimada en base a coordenadas y el nombre del destino.
 */
export const estimateFareByDistance = (
  originLat: number,
  originLng: number,
  destinationLat: number | null | undefined,
  destinationLng: number | null | undefined,
  destinationName?: string
): FareEstimate => {
  const safeDestLat = typeof destinationLat === "number" && Number.isFinite(destinationLat) ? destinationLat : originLat;
  const safeDestLng = typeof destinationLng === "number" && Number.isFinite(destinationLng) ? destinationLng : originLng;

  const distance = calculateDistance(originLat, originLng, safeDestLat, safeDestLng);

  // PASO A: Verificar si es un lugar conocido (Override)
  if (destinationName) {
    const knownPrice = getKnownLocationPrice(destinationName);
    if (knownPrice !== null) {
      return {
        distanceKm: Number(distance.toFixed(2)),
        estimatedPrice: knownPrice,
      };
    }
  }

  // PASO B: Calcular por distancia
  const estimatedPrice = calcularTarifaPorDistancia(distance);

  return {
    distanceKm: Number(distance.toFixed(2)),
    estimatedPrice,
  };
};

function getKnownLocationPrice(name: string): number | null {
  const normalizedName = name.toLowerCase().trim();
  for (const [key, price] of Object.entries(KNOWN_LOCATIONS)) {
    if (normalizedName.includes(key)) {
      return price;
    }
  }
  return null;
}

/**
 * Calcula la tarifa en base exclusivamente a los kilómetros recorridos.
 */
export function calcularTarifaPorDistancia(distanciaKm: number): number {
  if (!distanciaKm || distanciaKm <= 0) return 50;

  // 1. Revisar tramos definidos
  for (const tier of FARE_TIERS) {
    if (distanciaKm <= tier.maxKm) {
      return tier.price;
    }
  }

  // 2. Para distancias mayores a 5.9 km: $12 MXN por cada km extra
  const kmExtra = distanciaKm - 5.9;
  const tarifaCalculada = 105 + Math.ceil(kmExtra) * 12;

  // 3. Redondeo al múltiplo de 5 más cercano
  return Math.ceil(tarifaCalculada / 5) * 5;
}