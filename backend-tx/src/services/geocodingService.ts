import axios from "axios";

const geoCache: Record<string, string> = {};

export const reverseGeocode = async (lat: number, lng: number): Promise<string> => {
    if (lat == null || lng == null) return "Dirección no disponible";

    const token = process.env.MAPBOX_TOKEN;

    // 🎯 CACHÉ DE ALTA PRECISIÓN: 6 decimales equivalen a 10 centímetros de precisión. 
    // Evita colisiones de direcciones en calles muy densas de Valles.
    const cacheKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    if (geoCache[cacheKey]) return geoCache[cacheKey];

    try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`;

        const res = await axios.get<any>(url, {
            params: {
                access_token: token,
                limit: 1, // Evita error 422
                language: 'es'
            }
        });

        const features = res.data?.features;
        let direccion = "Dirección desconocida";

        if (features && features.length > 0) {
            const f = features[0];
            const fullText = f.place_name;

            // 1. Limpiamos lo que NO queremos ver para no alterar el split
            const cleanText = fullText
                .replace(/, San Luis Potosí/gi, '')
                .replace(/, México/gi, '')
                .replace(/, SLP/gi, '')
                .replace(/\d{5}/g, '') // Quita Códigos Postales
                .replace(/,\s*,/g, ',') // Corrige comas dobles si quedaron
                .trim();

            const parts = cleanText.split(',').map(p => p.trim());
            const calleYNum = parts[0]; // La calle siempre es el primer elemento

            // 2. 🎯 EXTRACCIÓN MAESTRA DEL CONTEXTO
            let coloniaContext = "";
            f.context?.forEach((c: any) => {
                // Mapbox clasifica las colonias/fraccionamientos como 'neighborhood' o 'locality'
                if (c.id.includes('neighborhood') || c.id.includes('locality')) {
                    coloniaContext = c.text;
                }
            });

            // 3. RECONSTRUCCIÓN INTELIGENTE ADAPTATIVA
            if (coloniaContext) {
                direccion = `${calleYNum}, Col. ${coloniaContext}, Ciudad Valles`;
            } else if (parts.length >= 3) {
                const coloniaText = parts[1];
                if (coloniaText.toLowerCase() !== "ciudad valles") {
                    direccion = `${calleYNum}, Col. ${coloniaText}, Ciudad Valles`;
                } else {
                    direccion = `${calleYNum}, Ciudad Valles`;
                }
            } else if (parts.length === 2) {
                direccion = `${calleYNum}, ${parts[1]}`;
            } else {
                direccion = parts[0];
            }
        }

        geoCache[cacheKey] = direccion;
        console.log(`✅ DIRECCIÓN DETALLADA GENERADA: ${direccion}`);
        return direccion;

    } catch (error: any) { // 🎯 BLINDAJE DE TYPESCRIPT
        console.error("❌ Error en reverseGeocode:", error.response?.data || error.message);
        return `Ubicación: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
};