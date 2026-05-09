import axios from "axios";

const geoCache: Record<string, string> = {};

export const reverseGeocode = async (lat: number, lng: number): Promise<string> => {
    if (lat == null || lng == null) return "Dirección no disponible";

    const token = process.env.MAPBOX_TOKEN;
    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (geoCache[cacheKey]) return geoCache[cacheKey];

    try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`;

        const res = await axios.get<any>(url, {
            params: {
                access_token: token,
                limit: 1, // Volvemos a 1 para evitar el error 422
                language: 'es'
            }
        });

        const features = res.data?.features;
        let direccion = "Dirección desconocida";

        if (features && features.length > 0) {
            const f = features[0];
            // 'place_name' en México suele ser: "Calle Numero, Colonia, Ciudad, Estado, Pais"
            const fullText = f.place_name;

            // 1. Limpiamos lo que NO queremos ver (Estado y País)
            const cleanText = fullText
                .replace(/, San Luis Potosí/gi, '')
                .replace(/, México/gi, '')
                .replace(/, SLP/gi, '')
                .replace(/\d{5}/g, '') // Quita Códigos Postales
                .trim();

            // 2. Dividimos por comas
            const parts = cleanText.split(',').map(p => p.trim());

            // 3. Lógica de Reconstrucción para Valles
            if (parts.length >= 3) {
                // [Calle y Num, Colonia, Ciudad]
                const calle = parts[0];
                const colonia = parts[1];
                const ciudad = parts[2];
                direccion = `${calle}, Col. ${colonia}, ${ciudad}`;
            }
            else if (parts.length === 2) {
                // [Calle y Num, Ciudad] -> Aquí la colonia no vino, intentamos buscarla en el context
                const calle = parts[0];
                let coloniaContext = "";

                f.context?.forEach((c: any) => {
                    if (c.id.includes('neighborhood')) coloniaContext = c.text;
                });

                if (coloniaContext) {
                    direccion = `${calle}, Col. ${coloniaContext}, ${parts[1]}`;
                } else {
                    direccion = `${calle}, ${parts[1]}`;
                }
            } else {
                direccion = parts[0];
            }
        }

        geoCache[cacheKey] = direccion;
        console.log(`✅ DIRECCIÓN GENERADA: ${direccion}`);
        return direccion;

    } catch (err: any) {
        console.error("❌ Error en Mapbox:", err.response?.data || err.message);
        return `Ubicación: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
};