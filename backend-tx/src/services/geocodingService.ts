import axios from "axios";

const geoCache: Record<string, string> = {};

export const reverseGeocode = async (lat: number, lng: number): Promise<string> => {
    if (lat == null || lng == null) return "Dirección no disponible";

    const token = process.env.MAPBOX_TOKEN;
    const cacheKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    if (geoCache[cacheKey]) return geoCache[cacheKey];

    try {
        // ==================== MOTOR 1: MAPBOX ====================
        const urlMapbox = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`;
        const resMapbox = await axios.get<any>(urlMapbox, {
            params: { access_token: token, limit: 1, language: 'es' }
        });

        const features = resMapbox.data?.features;
        let direccion = "Dirección desconocida";
        let tieneColonia = false;

        if (features && features.length > 0) {
            const f = features[0];
            const cleanText = f.place_name
                .replace(/, San Luis Potosí/gi, '').replace(/, México/gi, '').replace(/, SLP/gi, '').replace(/\d{5}/g, '').replace(/,\s*,/g, ',').trim();

            const parts = cleanText.split(',').map(p => p.trim());
            const calleYNum = parts[0];

            let coloniaContext = "";
            f.context?.forEach((c: any) => {
                if (c.id.includes('neighborhood') || c.id.includes('locality') || c.id.includes('suburb')) {
                    coloniaContext = c.text;
                }
            });

            if (!coloniaContext && parts.length >= 3 && parts[1].toLowerCase() !== "ciudad valles") {
                coloniaContext = parts[1];
            }

            if (coloniaContext && coloniaContext.toLowerCase() !== "ciudad valles") {
                const coloniaLimpia = coloniaContext.replace(/Colonia|Col\./gi, '').trim();
                direccion = `${calleYNum}, Col. ${coloniaLimpia}, Ciudad Valles`;
                tieneColonia = true;
            } else {
                direccion = parts[0].includes("Ciudad Valles") ? parts[0] : `${parts[0]}, Ciudad Valles`;
            }
        }

        // ==================== 🎯 MOTOR 2: FALLBACK OPENSTREETMAP (NOMINATIM) ====================
        if (!tieneColonia) {
            try {
                console.log("🔄 Mapbox sin colonia. Activando motor de respaldo OpenStreetMap...");
                const urlOsm = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;

                const resOsm = await axios.get<any>(urlOsm, {
                    headers: { "User-Agent": "TaxiAppValles/1.0" }
                });

                const addr = resOsm.data?.address;
                if (addr) {
                    const barrio = addr.suburb || addr.neighbourhood || addr.quarter || addr.residential || addr.village;
                    const calleOsm = addr.road || direccion.split(',')[0];
                    const numeroOsm = addr.house_number || "";

                    if (barrio) {
                        // 🎯 LIMPIEZA ULTRA-PRECISA: Removemos duplicados
                        const barrioLimpio = barrio
                            .replace(/Colonia|Col\./gi, '')
                            .replace(/Fraccionamiento|Fracc\./gi, '')
                            .trim();

                        // Armamos el string final de forma limpia y estandarizada
                        direccion = `${calleOsm} ${numeroOsm}`.trim() + `, Col. ${barrioLimpio}, Ciudad Valles`;
                        console.log(`🏡 ¡Colonia rescatada por OpenStreetMap!: Col. ${barrioLimpio}`);
                    }
                }
            } catch (osmErr) {
                console.warn("⚠️ Fallback de OpenStreetMap no disponible, manteniendo resultado de Mapbox.");
            }
        }

        // 🎯 GUARDAMOS EN CACHÉ Y RETORNAMOS EL STRING FINAL COMPILADO
        geoCache[cacheKey] = direccion;
        console.log(`✅ DIRECCIÓN DETALLADA FINAL: ${direccion}`);
        return direccion;

    } catch (error: any) {
        console.error("❌ Error en reverseGeocode:", error.response?.data || error.message);
        return `Ubicación: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
};