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

  const baseFare = 50;
  const pricePerKm = 30;
  const minPrice = 50;

  const estimatedPrice = Math.max(minPrice, Math.round(baseFare + distance * pricePerKm));

  return {
    distanceKm: distance,
    estimatedPrice,
  };
};
