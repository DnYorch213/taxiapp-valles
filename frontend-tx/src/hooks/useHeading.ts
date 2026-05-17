import { useMemo } from "react";

export function useHeading(
    current: { lat: number; lng: number } | null,
    next: { lat: number; lng: number } | null,
    final: { lat: number; lng: number } | null,
    estado: string
) {
    return useMemo(() => {
        if (!current) return 0;

        // 🚩 Si está en curso, apuntamos al destino final
        if (estado === "encurso" && final) {
            const dx = final.lng - current.lng;
            const dy = final.lat - current.lat;
            let degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
            if (degrees < 0) degrees += 360;
            return degrees;
        }

        // 🚩 Si está en camino, apuntamos al siguiente punto de la ruta
        if (estado === "encamino" && next) {
            const dx = next.lng - current.lng;
            const dy = next.lat - current.lat;
            let degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
            if (degrees < 0) degrees += 360;
            return degrees;
        }

        return 0;
    }, [current, next, final, estado]);
}
