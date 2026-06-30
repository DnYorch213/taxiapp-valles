const EARTH_RADIUS_M = 6371000;
const MIN_HEADING_DISTANCE_M = 2;
const HEADING_SMOOTH_FACTOR = 0.35;

function toRad(value: number): number {
    return (value * Math.PI) / 180;
}

function toDeg(value: number): number {
    return (value * 180) / Math.PI;
}

function normalize360(angle: number): number {
    return (angle + 360) % 360;
}

function shortestAngleDelta(from: number, to: number): number {
    return ((to - from + 540) % 360) - 180;
}

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);

    const h =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

    return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bearingDegrees(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLng = toRad(b.lng - a.lng);

    const y = Math.sin(dLng) * Math.cos(lat2);
    const x =
        Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

    return normalize360(toDeg(Math.atan2(y, x)));
}

export function calcularHeading(
    current: { lat: number; lng: number } | null,
    next: { lat: number; lng: number } | null,
    final: { lat: number; lng: number } | null,
    estado: string,
    prevHeading: number = 0
): number {
    if (!current) return prevHeading;

    const target = estado === "encurso" && final ? final : next;
    if (!target) return prevHeading;

    if (distanceMeters(current, target) < MIN_HEADING_DISTANCE_M) {
        return prevHeading;
    }

    const rawHeading = bearingDegrees(current, target);
    const delta = shortestAngleDelta(prevHeading, rawHeading);
    return normalize360(prevHeading + delta * HEADING_SMOOTH_FACTOR);
}
