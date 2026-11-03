/**
 * 🏷️ Marca de compilación del cliente.
 *
 * Se imprime en consola al arrancar y viaja en el handshake del socket, de modo
 * que el backend puede registrar qué versión está corriendo cada dispositivo.
 * Sirve para detectar móviles con un bundle viejo en caché cuando un síntoma
 * "no debería" ocurrir con el código ya desplegado.
 */
export const BUILD_TAG = "2026-11-02-posicion-v3";
