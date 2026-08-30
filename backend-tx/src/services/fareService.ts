import { calculateDistance } from "../utils/distance";

export interface FareEstimate {
  distanceKm: number;
  estimatedPrice: number;
}

export const estimateFareByDistance = (
  originLat: number,
  originLng: number,
  destinationLat: number | null | undefined,
  destinationLng: number | null | undefined
): FareEstimate => {
  const safeDestLat = typeof destinationLat === "number" && Number.isFinite(destinationLat) ? destinationLat : originLat;
  const safeDestLng = typeof destinationLng === "number" && Number.isFinite(destinationLng) ? destinationLng : originLng;

  const distance = calculateDistance(originLat, originLng, safeDestLat, safeDestLng);
  const estimatedPrice = calcularTarifaPorDistancia(distance);

  return {
    distanceKm: distance,
    estimatedPrice,
  };
};

/**
 * Calcula la tarifa estimada en base exclusivamente a los kilómetros recorridos.
 * @param distanciaKm Distancia del viaje en kilómetros.
 * @returns Tarifa sugerida en MXN (número entero).
 */
export function calcularTarifaPorDistancia(distanciaKm: number): number {
  if (!distanciaKm || distanciaKm <= 0) return 50;

  if (distanciaKm <= 1.0) {
    return 50;
  }

  if (distanciaKm <= 2.0) {
    return 75;
  }

  if (distanciaKm <= 3.0) {
    return 80;
  }

  if (distanciaKm <= 4.0) {
    return 90;
  }

  if (distanciaKm <= 5.0) {
    return 100;
  }

  if (distanciaKm <= 6.0) {
    return 105;
  }

  const kmExtra = distanciaKm - 6.0;
  const tarifaCalculada = 105 + Math.ceil(kmExtra) * 12;

  return Math.ceil(tarifaCalculada / 5) * 5;
}
