/**
 * 💵 TARIFAS DE TaxiApp-Valles — copia de la regla del frontend.
 *
 * Regla:
 *  · Banderazo: $50 hasta 0.5 km.
 *  · Después, el precio sube **1 peso por cada 100 metros** (antes subía de
 *    golpe 5 pesos cada 500 m: la misma tarifa, pero con brincos).
 *  · Tope: $210 a partir de 16 km.
 *
 * Los precios en los múltiplos de 500 m NO cambian respecto a la tabla
 * anterior: sólo se subdividen los escalones. El tramo corto (0.5 → 1.0 km)
 * sube 2 pesos cada 100 m para seguir llegando a $60 en el primer kilómetro.
 *
 * ⚠️ El frontend tiene la misma regla en `frontend-tx/src/utils/fare.ts`.
 * Al cambiar algo aquí hay que cambiarlo allá (y viceversa).
 *
 * Nota: hoy la tarifa que se guarda en el viaje la calcula el cliente con el
 * enrutador y llega en `estimatedFare`; este módulo deja la regla disponible
 * para el servidor (validaciones, historial o recálculos).
 */

/** Tarifa mínima (banderazo), aplicable hasta {@link TARIFA_BASE_KM}. */
export const TARIFA_MINIMA_MXN = 50;

/** Distancia que cubre el banderazo. */
export const TARIFA_BASE_KM = 0.5;

/** Segundo anclaje: lo que cuesta el primer kilómetro. */
export const TARIFA_TRAMO_CORTO_KM = 1;
export const TARIFA_TRAMO_CORTO_MXN = 60;

/** Tope de la tabla y distancia a partir de la cual se aplica. */
export const TARIFA_TOPE_KM = 16;
export const TARIFA_TOPE_MXN = 210;

/** Granularidad del escalón: 100 metros. */
export const PASO_TARIFA_KM = 0.1;

/** Pesos que sube cada paso de 100 m en el tramo 1 km → 16 km. */
export const PESO_POR_PASO = 1;

/** Pesos que sube cada paso de 100 m entre 0.5 km y 1 km (derivado: 2). */
export const PESO_POR_PASO_CORTO =
    (TARIFA_TRAMO_CORTO_MXN - TARIFA_MINIMA_MXN) /
    ((TARIFA_TRAMO_CORTO_KM - TARIFA_BASE_KM) / PASO_TARIFA_KM);

/**
 * Pasos de 100 m completados. Se resta un epsilon para que los múltiplos
 * exactos (1.0, 1.5, 16…) no salten de escalón por error de coma flotante.
 */
const pasosDeCienMetros = (km: number): number =>
    Math.max(0, Math.ceil(km / PASO_TARIFA_KM - 1e-9));

/**
 * Precio en pesos para una distancia vial. Devuelve siempre un entero.
 */
export const calcularTarifaPorDistancia = (distanciaKm: number): number => {
    if (!Number.isFinite(distanciaKm) || distanciaKm <= 0) {
        return TARIFA_MINIMA_MXN;
    }

    if (distanciaKm <= TARIFA_BASE_KM) {
        return TARIFA_MINIMA_MXN;
    }

    if (distanciaKm <= TARIFA_TRAMO_CORTO_KM) {
        const pasos = pasosDeCienMetros(distanciaKm - TARIFA_BASE_KM);

        return Math.min(
            TARIFA_MINIMA_MXN + pasos * PESO_POR_PASO_CORTO,
            TARIFA_TRAMO_CORTO_MXN
        );
    }

    const pasos = pasosDeCienMetros(distanciaKm - TARIFA_TRAMO_CORTO_KM);

    return Math.min(
        TARIFA_TRAMO_CORTO_MXN + pasos * PESO_POR_PASO,
        TARIFA_TOPE_MXN
    );
};

/**
 * Tabla de referencia con el precio que devuelve el cálculo suave en cada
 * hito (sirve para comparar de un vistazo con la tabla anterior).
 */
export const TABLA_TARIFAS_REFERENCIA = [
    { km: 0.5, precio: 50 },
    { km: 1.0, precio: 60 },
    { km: 1.5, precio: 65 },
    { km: 2.0, precio: 70 },
    { km: 3.0, precio: 80 },
    { km: 4.0, precio: 90 },
    { km: 5.0, precio: 100 },
    { km: 6.0, precio: 110 },
    { km: 8.0, precio: 130 },
    { km: 10.0, precio: 150 },
    { km: 12.0, precio: 170 },
    { km: 14.0, precio: 190 },
    { km: 16.0, precio: 210 },
];
