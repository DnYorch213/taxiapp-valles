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

            // 1. Limpieza base
            const cleanText = fullText
                .replace(/, San Luis Potosí/gi, '')
                .replace(/, México/gi, '')
                .replace(/, SLP/gi, '')
                .replace(/\d{5}/g, '') // Quita Códigos Postales
                .replace(/,\s*,/g, ',')
                .trim();

            const parts = cleanText.split(',').map(p => p.trim());
            const calleYNum = parts[0];

            // 2. 🎯 EXTRACCIÓN MAESTRA CON ESCANEO PROFUNDO (Multi-Feature & Context)
            let coloniaContext = "";

            // Intento A: Buscar en el contexto del primer feature
            f.context?.forEach((c: any) => {
                if (c.id.includes('neighborhood') || c.id.includes('locality') || c.id.includes('suburb')) {
                    coloniaContext = c.text;
                }
            });

            // Intento B: Si sigue vacío, escaneamos las características secundarias que mandó Mapbox
            if (!coloniaContext && features.length > 1) {
                for (const feat of features) {
                    if (feat.id?.includes('neighborhood') || feat.id?.includes('locality')) {
                        coloniaContext = feat.text;
                        break;
                    }
                }
            }

            // Intento C: Fallback definitivo si Mapbox nos da un texto plano de 3 partes
            if (!coloniaContext && parts.length >= 3) {
                const posibleColonia = parts[1];
                if (posibleColonia.toLowerCase() !== "ciudad valles") {
                    coloniaContext = posibleColonia;
                }
            }

            // 3. RECONSTRUCCIÓN FINAL CON COLONIA GARANTIZADA SI EXISTE
            if (coloniaContext && coloniaContext.toLowerCase() !== "ciudad valles") {
                // Limpiamos palabras repetidas por si Mapbox manda la colonia dos veces
                const coloniaLimpia = coloniaContext.replace(/Colonia|Col\./gi, '').trim();
                direccion = `${calleYNum}, Col. ${coloniaLimpia}, Ciudad Valles`;
            } else if (parts.length === 2) {
                direccion = `${calleYNum}, ${parts[1]}`;
            } else {
                direccion = parts[0].includes("Ciudad Valles") ? parts[0] : `${parts[0]}, Ciudad Valles`;
            }
        }

        geoCache[cacheKey] = direccion;
        console.log(`✅ DIRECCIÓN DETALLADA GENERADA: ${direccion}`);
        return direccion;
    } catch (error) {
        console.error("❌ Error en reverseGeocode:", error);
        return "Dirección no disponible";
    }
};