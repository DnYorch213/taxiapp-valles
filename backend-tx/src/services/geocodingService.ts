import axios from "axios";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const geoCache: Record<string, string> = {};

export const reverseGeocode = async (lat: number, lng: number): Promise<string> => {
    if (lat == null || lng == null) return "Dirección no disponible";

    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (geoCache[cacheKey]) return geoCache[cacheKey];

    try {
        const res = await axios.get<any>(NOMINATIM_URL, {
            params: {
                lat,
                lon: lng,
                format: "json",
                addressdetails: 1,
            },
            headers: {
                "User-Agent": "TaxiAppValles/1.0 (tu-email@ejemplo.com)"
            }
        });

        const addr = res.data?.address;
        let direccion = "Dirección desconocida";

        if (addr) {
            // Formateamos una dirección amigable para Valles
            const calle = addr.road || addr.pedestrian || "";
            const numero = addr.house_number || "";
            const colonia = addr.suburb || addr.neighbourhood || "";

            direccion = `${calle} ${numero}, ${colonia}`.trim().replace(/^,|,$/g, "");
            if (!calle && !colonia) direccion = res.data.display_name.split(',')[0];
        }

        geoCache[cacheKey] = direccion;
        return direccion;
    } catch (err) {
        console.error("❌ Error en Nominatim:", err);
        return "Dirección no disponible";
    }
};