import axios from "axios";

// 🚩 Coloca tu token aquí o en tu archivo .env
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const geoCache: Record<string, string> = {};

export const reverseGeocode = async (lat: number, lng: number): Promise<string> => {
    if (lat == null || lng == null) return "Dirección no disponible";

    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (geoCache[cacheKey]) return geoCache[cacheKey];

    try {
        // Mapbox usa: /geocoding/v5/mapbox.places/{longitude},{latitude}.json
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`;

        const res = await axios.get<any>(url, {
            params: {
                access_token: MAPBOX_TOKEN,
                limit: 1,
                language: 'es', // Direcciones en español
                types: 'address,poi,neighborhood' // Prioriza calles y puntos de interés
            }
        });

        const features = res.data?.features;
        let direccion = "Dirección desconocida";

        if (features && features.length > 0) {
            const fullAddress = features[0].place_name;
            const parts = fullAddress.split(',');

            // 1. La calle siempre es el primer elemento
            const calle = parts[0].trim();

            // 2. Buscamos la ciudad (usualmente es la penúltima o antepenúltima antes de México/Estado)
            // Filtramos para quitar códigos postales de cualquier parte
            const cleanParts = parts
                .map(p => p.replace(/\d{5}/g, '').trim()) // Quita CPs de 5 dígitos
                .filter(p => p.toLowerCase() !== 'méxico' && p !== '');

            if (cleanParts.length >= 2) {
                // Tomamos la Calle y el último elemento disponible (que suele ser la Ciudad)
                const ciudad = cleanParts[cleanParts.length - 1];

                // Si hay un elemento intermedio (como la colonia), lo incluimos
                if (cleanParts.length >= 3) {
                    const colonia = cleanParts[1];
                    direccion = `${calle}, ${colonia}, ${ciudad}`;
                } else {
                    direccion = `${calle}, ${ciudad}`;
                }
            } else {
                direccion = cleanParts[0];
            }
        }

        geoCache[cacheKey] = direccion;
        return direccion;

    } catch (err: any) {
        console.error("❌ Error en Mapbox:", err.response?.data || err.message);
        // Fallback para no detener la prueba de Yorchi y Kokito
        return `Ubicación: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
};