// src/socket/handlers/tripHandler.ts
import { Server, Socket } from "socket.io";
import { Position } from "../../models/Position";
import { Trip } from "../../models/Trip";
import { buildPayload } from "../../utils/payloadBuilder";
import { reverseGeocode } from "../../services/geocodingService";
import { bindPassengerRequestId, clearPassengerRequestBinding, clearPendingTimeouts, clearRequestTimeouts, dispatchWithRetry, getActiveRequestIdForPassenger, clearDispatchCycle } from "../../services/dispatchService";
import { logMotor } from "../../utils/logger";
import { calculateDistance } from "../../utils/distance";
import { POSITION_STATES, TRIP_STATES } from "../../constants/states";

export const registerTripHandlers = (io: Server, socket: Socket, email: string) => {

    // ============================================================
    // 🎯 SOLICITUD DE TAXI - CON TRANSACCIÓN ATÓMICA
    // ============================================================
    socket.on("request_taxi", async (data: any) => {
        const pEmail = data.email?.toLowerCase().trim();
        if (!pEmail) return;

        // 🛡️ VALIDACIÓN: El socket debe ser del pasajero que solicita
        if (email !== pEmail) {
            logMotor("request_taxi", `⚠️ Socket=${email} intentó solicitar taxi para ${pEmail}`, "WARN");
            return;
        }

        try {
            // 🎯 TRANSACCIÓN ATÓMICA: Verificar y actualizar en un solo paso
            const session = await Position.startSession();
            session.startTransaction();

            try {
                // Buscar viaje existente dentro de la transacción
                const viajeExistente = await Position.findOne({
                    $or: [
                        {
                            email: pEmail,
                            estado: {
                                $in: [
                                    POSITION_STATES.ENCAMINO,
                                    POSITION_STATES.ENCURSO,
                                    POSITION_STATES.ASIGNADO,
                                    POSITION_STATES.PREASIGNADO,
                                    POSITION_STATES.BUSCANDO
                                ]
                            }
                        },
                        {
                            email: pEmail,
                            role: "pasajero",
                            taxistaAsignado: { $ne: null }
                        }
                    ]
                }).session(session).lean();

                // Si ya tiene viaje activo, abortar transacción y responder
                if (viajeExistente) {
                    await session.abortTransaction();
                    session.endSession();

                    logMotor("request_taxi",
                        `Pasajero=${pEmail} Estado=${viajeExistente.estado} -> Solicitud ignorada`,
                        "WARN"
                    );

                    const taxistaData = viajeExistente.taxistaAsignado
                        ? await Position.findOne({ email: viajeExistente.taxistaAsignado }).lean()
                        : null;

                    return socket.emit("response_from_taxi", {
                        accepted: true,
                        tEmail: viajeExistente.taxistaAsignado || "",
                        name: taxistaData?.name || "Conductor",
                        taxiNumber: taxistaData?.taxiNumber || "ECO",
                        lat: taxistaData?.lat || null,
                        lng: taxistaData?.lng || null,
                        estado: viajeExistente.estado
                    });
                }

                // Crear nuevo request ID
                clearPendingTimeouts(pEmail, "nuevo request_taxi");

                const currentRequestId = new Date().getTime().toString();
                bindPassengerRequestId(pEmail, currentRequestId);

                // Actualizar posición a BUSCANDO
                await Position.findOneAndUpdate(
                    { email: pEmail },
                    {
                        $set: {
                            estado: POSITION_STATES.BUSCANDO,
                            lat: data.lat,
                            lng: data.lng,
                            destinationLat: data.destinationLat ?? null,
                            destinationLng: data.destinationLng ?? null,
                            name: data.name || "Pasajero",
                            role: "pasajero",
                            taxistaAsignado: null,
                            pasajeroAsignado: currentRequestId,
                            requestId: currentRequestId,
                            destinationAddress: data.destinationAddress || null,
                            updatedAt: new Date()
                        }
                    },
                    { upsert: true, session, returnDocument: "after" }
                );

                // Confirmar transacción
                await session.commitTransaction();
                session.endSession();

                logMotor("request_taxi",
                    `Solicitud legítima de: ${pEmail} (ID: ${currentRequestId})`,
                    "INFO"
                );

                // 🧭 Resolver la dirección antes de despachar para no mandar payloads vacíos
                let pickupAddress = data.pickupAddress || "Calculando ubicación...";
                try {
                    pickupAddress = await reverseGeocode(data.lat, data.lng);

                    const validacionP = await Position.findOne({ email: pEmail }).lean();

                    if (validacionP &&
                        [POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO, POSITION_STATES.ASIGNADO, POSITION_STATES.PREASIGNADO].includes(validacionP.estado as any)) {
                        logMotor("geocoding",
                            `Ignorando dirección tardía para ${pEmail}. Estado=${validacionP.estado}`,
                            "WARN"
                        );
                    } else if (validacionP?.requestId === currentRequestId) {
                        await Position.updateOne(
                            { email: pEmail },
                            { $set: { pickupAddress } }
                        );
                        logMotor("geocoding",
                            `Dirección inyectada: ${pickupAddress} para ${pEmail}`,
                            "INFO"
                        );
                    }
                } catch (geoError) {
                    logMotor("geocoding",
                        `Error en geocoding para ${pEmail}: ${geoError}`,
                        "ERROR"
                    );
                    pickupAddress = "Ubicación no disponible";
                }

                // Preparar payload para dispatch
                const pasajeroPayload = {
                    email: pEmail,
                    name: data.name || "Pasajero",
                    lat: data.lat,
                    lng: data.lng,
                    pickupAddress,
                    destinationLat: data.destinationLat ?? null,
                    destinationLng: data.destinationLng ?? null,
                    destinationAddress: data.destinationAddress || "Destino no especificado",
                    requestId: currentRequestId
                };

                logMotor("request_taxi",
                    `Buscando unidad más cercana para ${pEmail}`,
                    "INFO"
                );

                // Despachar
                dispatchWithRetry(io, pasajeroPayload, [], 1);

            } catch (error) {
                await session.abortTransaction();
                session.endSession();
                throw error;
            }

        } catch (error) {
            logMotor("error",
                `Error en request_taxi para ${pEmail}: ${error}`,
                "ERROR"
            );
        }
    });

    // ============================================================
    // 🎯 RESPUESTA DEL TAXI - CON VALIDACIÓN DE AUTORIZACIÓN
    // ============================================================
    socket.on("taxi_response", async ({ requestEmail, accepted, excludedEmails = [] }) => {
        const tEmail = email; // Email del taxista dueño de este socket
        const pEmail = requestEmail?.toLowerCase().trim();

        if (!tEmail || !pEmail) return;

        // 🛡️ VALIDACIÓN: El socket debe ser del taxista que responde
        const pasajero = await Position.findOne({ email: pEmail });
        if (pasajero?.taxistaAsignado !== tEmail) {
            logMotor("taxi_response", `⚠️ Taxista ${tEmail} intentó responder sin estar asignado al pasajero ${pEmail}`, "WARN");
            return;
        }


        // 🎯 LIMPIEZA PREVENTIVA: Cancelar timeout del pasajero
        if (getActiveRequestIdForPassenger(pEmail)) {
            clearPendingTimeouts(pEmail, "respuesta del taxi");
            logMotor("taxi_response", `Pasajero=${pEmail} -> Timeout cancelado`, "INFO");
        }

        // 🚨 CASO: TAXISTA RECHAZA
        if (!accepted) {
            await Position.updateOne(
                { email: tEmail },
                { $set: { estado: POSITION_STATES.ACTIVO, pasajeroAsignado: null } }
            );

            await Position.updateOne(
                {
                    email: pEmail,
                    estado: { $in: [POSITION_STATES.BUSCANDO, POSITION_STATES.PREASIGNADO, POSITION_STATES.ASIGNADO] }
                },
                {
                    $set: {
                        estado: POSITION_STATES.BUSCANDO,
                        taxistaAsignado: null,
                        updatedAt: new Date()
                    }
                }
            );

            const tPos = await Position.findOne({ email: tEmail });
            io.emit("panel_update", buildPayload(tPos, tPos, POSITION_STATES.ACTIVO));
            io.to(pEmail).emit("taxi_rejected_request");

            const pData = await Position.findOne({ email: pEmail });
            if (pData) {
                dispatchWithRetry(io, pData, [...excludedEmails, tEmail], 1);
            }
            return;
        }

        // 🚖 CASO: TAXISTA ACEPTA
        try {

            // 🛡️ VALIDAR QUE EL PASAJERO NO ESTÉ CANCELADO
            const pPos = await Position.findOne({ email: pEmail });
            if (!pPos || pPos.estado === POSITION_STATES.CANCELADO) {
                return io.to(tEmail).emit("trip_already_taken", {
                    message: "El pasajero canceló la solicitud."
                });
            }
            // 🎯 TRANSACCIÓN ATÓMICA para asignar viaje
            const session = await Position.startSession();
            session.startTransaction();

            try {
                // Actualizar pasajero a ENCAMINO
                const pPosActualizado = await Position.findOneAndUpdate(
                    {
                        email: pEmail,
                        estado: {
                            $in: [
                                POSITION_STATES.BUSCANDO,
                                POSITION_STATES.PREASIGNADO,
                                POSITION_STATES.ACTIVO
                            ]
                        }
                    },
                    {
                        $set: {
                            estado: POSITION_STATES.ENCAMINO,
                            taxistaAsignado: tEmail,
                            updatedAt: new Date()
                        }
                    },
                    { session, returnDocument: "after" }
                );

                if (!pPosActualizado) {
                    await session.abortTransaction();
                    session.endSession();
                    return io.to(tEmail).emit("trip_already_taken", {
                        message: "¡Lo sentimos! Solicitud expirada o tomada por otro compañero."
                    });
                }

                // Actualizar taxista a ENCAMINO
                await Position.updateOne(
                    { email: tEmail },
                    {
                        $set: {
                            estado: POSITION_STATES.ENCAMINO,
                            pasajeroAsignado: pEmail,
                            updatedAt: new Date()
                        }
                    },
                    { session }
                );

                await session.commitTransaction();
                session.endSession();

                // 🛡️ Candado: cerrar la solicitud para evitar más reintentos
                if (pPosActualizado?.requestId) {
                    clearDispatchCycle(pPosActualizado.requestId, "viaje aceptado");
                    clearPassengerRequestBinding(pEmail);
                }


                // 🎯 LIMPIEZA EXTREMA: Matar cualquier timeout residual
                clearPendingTimeouts(pEmail, "aceptación push");

                // Obtener datos frescos
                const tPos = await Position.findOne({ email: tEmail });

                // 🚀 EMITIR EVENTOS
                io.to(pEmail).emit("response_from_taxi", {
                    accepted: true,
                    tEmail,
                    name: tPos?.name || "Conductor",
                    taxiNumber: tPos?.taxiNumber || "S/N",
                    estado: POSITION_STATES.ENCAMINO,
                    lat: tPos?.lat,
                    lng: tPos?.lng,
                    taxiData: buildPayload(tPos, tPos, POSITION_STATES.ENCAMINO),
                    pasajeroEmail: pEmail,
                    pasajeroLat: pPosActualizado.lat,
                    pasajeroLng: pPosActualizado.lng,
                    distancia: (tPos?.lat && tPos?.lng && pPosActualizado.lat && pPosActualizado.lng)
                        ? calculateDistance(
                            pPosActualizado.lat,
                            pPosActualizado.lng,
                            tPos.lat,
                            tPos.lng
                        )
                        : null
                });

                io.to(tEmail).emit("assignment_confirmed", {
                    success: true,
                    pasajero: buildPayload(pPosActualizado, pPosActualizado, POSITION_STATES.ENCAMINO)
                });

                // 🎯 EMITIR ESTADO CORRECTO (asignado primero, luego encamino)
                io.to(pEmail).emit("trip_status_update", {
                    estado: POSITION_STATES.ASIGNADO,
                    pasajeroEmail: pEmail
                });

                io.to(tEmail).emit("trip_status_update", {
                    estado: POSITION_STATES.ENCAMINO
                });

                // Actualizar paneles
                io.emit("panel_update", buildPayload(tPos, tPos, POSITION_STATES.ENCAMINO, {
                    pasajeroAsignado: pEmail
                }));
                io.emit("panel_update", buildPayload(pPosActualizado, pPosActualizado, POSITION_STATES.ENCAMINO, {
                    taxistaAsignado: tEmail
                }));

            } catch (error) {
                await session.abortTransaction();
                session.endSession();
                throw error;
            }

        } catch (error) {
            logMotor("taxi_response",
                `Error al asignar viaje a ${pEmail}: ${error}`,
                "ERROR"
            );
            io.to(tEmail).emit("assignment_confirmed", {
                success: false,
                message: "Error al asignar el viaje. Intenta nuevamente."
            });
        }
    });

    // ============================================================
    // 🎯 MENSAJERÍA - CON VALIDACIÓN
    // ============================================================
    socket.on("send_message", ({ toEmail, message, fromName }) => {
        const destinatario = toEmail?.toLowerCase().trim();
        if (!destinatario) return;

        // 🛡️ Validación básica
        if (!message || message.trim().length === 0) return;

        io.to(destinatario).emit("receive_message", {
            fromEmail: email,
            fromName: fromName || "Sistema",
            message: message.trim(),
            timestamp: new Date().toISOString()
        });
    });

    // ============================================================
    // 🎯 PASAJERO A BORDO - SIN EMISIONES REDUNDANTES
    // ============================================================
    socket.on("passenger_on_board", async ({ taxistaEmail, pasajeroEmail }) => {
        if (!pasajeroEmail || !taxistaEmail) return;

        const pEmail = pasajeroEmail.toLowerCase().trim();
        const tEmail = taxistaEmail.toLowerCase().trim();

        if (pEmail === tEmail) {
            logMotor("passenger_on_board",
                `⚠️ Evento inválido: pasajeroEmail y taxistaEmail son iguales (${pEmail})`,
                "WARN"
            );
            return;
        }

        // 🛡️ VALIDACIÓN: El socket debe ser del taxista
        if (email !== tEmail) {
            logMotor("passenger_on_board",
                `⚠️ Socket=${email} intentó marcar subida para taxista=${tEmail}`,
                "WARN"
            );
            return;
        }

        try {
            let [pActual, tActual] = await Promise.all([
                Position.findOne({ email: pEmail }).lean(),
                Position.findOne({ email: tEmail }).lean()
            ]);

            if (!pActual || !tActual) {
                logMotor("passenger_on_board",
                    `⚠️ Relación inválida para subir pasajero. P=${pEmail} T=${tEmail} (documentos faltantes)`,
                    "WARN"
                );
                return;
            }

            const passengerMatchesTaxi = pActual.taxistaAsignado === tEmail;
            const taxiMatchesPassenger = tActual.pasajeroAsignado === pEmail;

            // Auto-repair seguro: solo cuando un lado está null y el otro ya coincide.
            if (!passengerMatchesTaxi && !pActual.taxistaAsignado && taxiMatchesPassenger) {
                await Position.updateOne(
                    { email: pEmail },
                    { $set: { taxistaAsignado: tEmail, updatedAt: new Date() } }
                );
                pActual = await Position.findOne({ email: pEmail }).lean();
            }

            if (!taxiMatchesPassenger && !tActual.pasajeroAsignado && passengerMatchesTaxi) {
                await Position.updateOne(
                    { email: tEmail },
                    { $set: { pasajeroAsignado: pEmail, updatedAt: new Date() } }
                );
                tActual = await Position.findOne({ email: tEmail }).lean();
            }

            if (!pActual || !tActual || pActual.taxistaAsignado !== tEmail || tActual.pasajeroAsignado !== pEmail) {
                logMotor(
                    "passenger_on_board",
                    `⚠️ Relación inválida para subir pasajero. P=${pEmail} (taxistaAsignado=${pActual?.taxistaAsignado || "null"}) T=${tEmail} (pasajeroAsignado=${tActual?.pasajeroAsignado || "null"})`,
                    "WARN"
                );
                return;
            }

            logMotor("passenger_on_board",
                `Pasajero=${pEmail} Taxista=${tEmail} -> Estado=EN_CURSO`,
                "INFO"
            );

            // 🎯 LIMPIEZA DE TIMEOUTS
            clearPendingTimeouts(pEmail, "subida de pasajero");
            logMotor("passenger_on_board",
                `Pasajero=${pEmail} -> Timeout limpiado`,
                "INFO"
            );

            // 🎯 TRANSACCIÓN ATÓMICA
            const session = await Position.startSession();
            session.startTransaction();

            try {
                // Invalidar requestId
                await Position.updateOne(
                    { email: pEmail },
                    { $set: { requestId: null } },
                    { session }
                );

                // Actualizar estados
                await Position.updateOne(
                    { email: tEmail },
                    { $set: { estado: POSITION_STATES.ENCURSO, updatedAt: new Date() } },
                    { session }
                );

                await Position.updateOne(
                    { email: pEmail },
                    { $set: { estado: POSITION_STATES.ENCURSO, updatedAt: new Date() } },
                    { session }
                );

                await session.commitTransaction();
                session.endSession();

                // Obtener documentos frescos
                const pPos = await Position.findOne({ email: pEmail });
                const tPos = await Position.findOne({ email: tEmail });

                // 🚀 EMITIR EVENTOS (UNA SOLA VEZ)
                const estadoPayload = {
                    estado: POSITION_STATES.ENCURSO,
                    pasajeroEmail: pEmail,
                    taxistaEmail: tEmail,
                    taxiData: tPos ? buildPayload(tPos, tPos, POSITION_STATES.ENCURSO) : null
                };

                io.to(pEmail).emit("trip_status_update", estadoPayload);
                io.to(tEmail).emit("trip_status_update", {
                    estado: POSITION_STATES.ENCURSO
                });

                // Actualizar paneles
                if (pPos) io.emit("panel_update", buildPayload(pPos, pPos, POSITION_STATES.ENCURSO));
                if (tPos) io.emit("panel_update", buildPayload(tPos, tPos, POSITION_STATES.ENCURSO));

            } catch (error) {
                await session.abortTransaction();
                session.endSession();
                throw error;
            }

        } catch (error) {
            logMotor("error",
                `Error en passenger_on_board para ${pEmail}: ${error}`,
                "ERROR"
            );
        }
    });

    // ============================================================
    // 🎯 CANCELACIÓN - CON LIMPIEZA EXHAUSTIVA
    // ============================================================
    socket.on("passenger_cancel", async ({ pasajeroEmail, taxistaEmail }) => {
        const pEmail = pasajeroEmail.toLowerCase().trim();
        const tEmail = taxistaEmail ? taxistaEmail.toLowerCase().trim() : null;

        // 🛡️ VALIDACIÓN: El socket debe ser del pasajero
        if (email !== pEmail) {
            logMotor("passenger_cancel",
                `⚠️ Socket=${email} intentó cancelar viaje de ${pEmail}`,
                "WARN"
            );
            return;
        }

        try {
            const estadoActualDoc = await Position.findOne({ email: pEmail }).lean();

            // Si ya está inactivo, bloquear
            if (!estadoActualDoc ||
                ["pendiente", "inactivo", "cancelado", "finalizado"].includes(estadoActualDoc.estado)) {
                logMotor("passenger_cancel",
                    `Pasajero=${pEmail} -> Cancelación bloqueada. Estado=${estadoActualDoc?.estado}`,
                    "WARN"
                );
                return;
            }

            logMotor("passenger_cancel",
                `Pasajero=${pEmail} -> Cancelación definitiva`,
                "WARN"
            );

            // 🎯 LIMPIEZA EXHAUSTIVA DE TIMEOUTS
            clearPendingTimeouts(pEmail, "cancelación pasajero");

            // 🎯 TRANSACCIÓN ATÓMICA
            const session = await Position.startSession();
            session.startTransaction();

            try {
                // Marcar pasajero como cancelado
                await Position.updateOne(
                    { email: pEmail },
                    {
                        $set: {
                            estado: "cancelado",
                            taxistaAsignado: null,
                            pickupAddress: null,
                            pasajeroAsignado: null,
                            requestId: null,
                            updatedAt: new Date()
                        }
                    },
                    { session }
                );

                // Liberar taxista si existe
                if (tEmail) {
                    await Position.updateOne(
                        { email: tEmail },
                        {
                            $set: {
                                estado: "activo",
                                pasajeroAsignado: null,
                                updatedAt: new Date()
                            }
                        },
                        { session }
                    );
                }

                await session.commitTransaction();
                session.endSession();

                // Notificar al taxista
                if (tEmail) {
                    io.to(tEmail).emit("trip_cancelled_by_passenger", {
                        message: "El pasajero ha cancelado la solicitud.",
                        newStatus: "activo"
                    });
                    io.to(tEmail).emit("dispatch_timeout");
                }

                // Notificar al pasajero
                const payloadCancel = {
                    pasajeroEmail: pEmail,
                    taxistaEmail: tEmail,
                    estado: "cancelado",
                    pasajeroLat: estadoActualDoc.lat,
                    pasajeroLng: estadoActualDoc.lng
                };

                io.to(pEmail).emit("trip_finished", payloadCancel);
                io.to(pEmail).emit("dispatch_timeout");

                // Actualizar paneles
                io.emit("panel_update", { email: pEmail, estado: "cancelado" });
                if (tEmail) io.emit("panel_update", { email: tEmail, estado: "activo" });

                logMotor("passenger_cancel",
                    `Pasajero=${pEmail} -> Cancelación finalizada`,
                    "WARN"
                );

            } catch (error) {
                await session.abortTransaction();
                session.endSession();
                throw error;
            }

        } catch (error) {
            logMotor("error",
                `Error en passenger_cancel para ${pEmail}: ${error}`,
                "ERROR"
            );
        }
    });

    // ============================================================
    // 🎯 FINALIZAR VIAJE - CON GEOCODIFICACIÓN NO BLOQUEANTE
    // ============================================================
    // ============================================================
    // 🎯 FINALIZAR VIAJE - CON GEOCODIFICACIÓN NO BLOQUEANTE
    // ============================================================
    socket.on("end_trip", async ({ pasajeroEmail, taxistaEmail }) => {
        const pEmail = pasajeroEmail?.toLowerCase().trim();
        const tEmail = taxistaEmail?.toLowerCase().trim();

        if (!pEmail || !tEmail) return;

        if (pEmail === tEmail) {
            logMotor("end_trip",
                `⚠️ Evento inválido: pasajeroEmail y taxistaEmail son iguales (${pEmail})`,
                "WARN"
            );
            return;
        }

        // 🛡️ VALIDACIÓN: El socket debe ser del taxista
        if (email !== tEmail) {
            logMotor("end_trip",
                `⚠️ Socket=${email} intentó finalizar viaje de taxista=${tEmail}`,
                "WARN"
            );
            return;
        }

        let session: any = null; // 🎯 Declarar session fuera del try

        try {
            let pPos = await Position.findOne({ email: pEmail });
            let tPos = await Position.findOne({ email: tEmail });

            if (!pPos || !tPos) {
                logMotor("end_trip",
                    `Documentos no encontrados: Pasajero=${pEmail} Taxista=${tEmail}`,
                    "ERROR"
                );
                return;
            }

            const passengerMatchesTaxi = pPos.taxistaAsignado === tEmail;
            const taxiMatchesPassenger = tPos.pasajeroAsignado === pEmail;

            // Auto-repair seguro: solo cuando uno de los lados está null y el otro ya coincide.
            if (!passengerMatchesTaxi && !pPos.taxistaAsignado && taxiMatchesPassenger) {
                await Position.updateOne(
                    { email: pEmail },
                    { $set: { taxistaAsignado: tEmail, updatedAt: new Date() } }
                );
                pPos = await Position.findOne({ email: pEmail });
            }

            if (!taxiMatchesPassenger && !tPos.pasajeroAsignado && passengerMatchesTaxi) {
                await Position.updateOne(
                    { email: tEmail },
                    { $set: { pasajeroAsignado: pEmail, updatedAt: new Date() } }
                );
                tPos = await Position.findOne({ email: tEmail });
            }

            if (!pPos || !tPos || pPos.taxistaAsignado !== tEmail || tPos.pasajeroAsignado !== pEmail) {
                logMotor("end_trip",
                    `Relación inconsistente al finalizar. P=${pEmail} (taxistaAsignado=${pPos?.taxistaAsignado || "null"}) T=${tEmail} (pasajeroAsignado=${tPos?.pasajeroAsignado || "null"})`,
                    "WARN"
                );
                return;
            }

            // 🚀 GEOCODIFICACIÓN EN SEGUNDO PLANO (no bloqueante)
            const direccionOrigen = pPos.pickupAddress || "Origen desconocido";

            // Guardar historial inmediatamente con datos disponibles
            const nuevoHistorial = new Trip({
                pasajeroEmail: pEmail,
                pasajeroName: pPos.name || "Pasajero",
                taxistaEmail: tEmail,
                taxistaName: tPos.name || "Taxista",
                taxiNumber: tPos.taxiNumber || "S/N",
                pickupAddress: direccionOrigen,
                destinationAddress: "Calculando...", // Placeholder
                estado: "finalizado",
                fecha: new Date()
            });
            await nuevoHistorial.save();

            // 🎯 TRANSACCIÓN ATÓMICA para actualizar estados
            session = await Position.startSession();
            session.startTransaction();

            try {
                await Position.updateOne(
                    { email: tEmail },
                    {
                        $set: {
                            estado: "activo",
                            pasajeroAsignado: null,
                            updatedAt: new Date()
                        }
                    },
                    { session }
                );

                await Position.updateOne(
                    { email: pEmail },
                    {
                        $set: {
                            estado: "finalizado",
                            taxistaAsignado: null,
                            pickupAddress: null,
                            pasajeroAsignado: null,
                            requestId: null,
                            updatedAt: new Date()
                        }
                    },
                    { session }
                );

                await session.commitTransaction();
            } catch (txError) {
                await session.abortTransaction();
                throw txError;
            } finally {
                session.endSession();
            }

            // Obtener documentos actualizados
            const pUpdated = await Position.findOne({ email: pEmail });
            const tUpdated = await Position.findOne({ email: tEmail });

            // Calcular distancia
            // 🆕 Validación explícita con variables tipadas
            let distancia: number | null = null;

            if (
                typeof pPos.lat === "number" &&
                typeof pPos.lng === "number" &&
                typeof tPos.lat === "number" &&
                typeof tPos.lng === "number"
            ) {
                distancia = calculateDistance(pPos.lat, pPos.lng, tPos.lat, tPos.lng);
            }

            // Emitir eventos
            const payloadFin = {
                pasajeroEmail: pEmail,
                taxistaEmail: tEmail,
                estado: "finalizado",
                pickupAddress: direccionOrigen,
                destinationAddress: "Calculando...",
                distancia
            };

            io.to(pEmail).emit("trip_finished", payloadFin);
            io.to(tEmail).emit("trip_finished", payloadFin);

            // Actualizar paneles
            if (pUpdated) io.emit("panel_update", buildPayload(pUpdated, pUpdated, "finalizado"));
            if (tUpdated) io.emit("panel_update", buildPayload(tUpdated, tUpdated, "activo"));

            // 🚀 GEOCODIFICACIÓN ASÍNCRONA para actualizar el historial
            reverseGeocode(tPos.lat!, tPos.lng!)
                .then(async (direccionDestino) => {
                    await Trip.updateOne(
                        { _id: nuevoHistorial._id },
                        { $set: { destinationAddress: direccionDestino } }
                    );

                    // Re-emitir con dirección completa
                    const payloadCompleto = {
                        ...payloadFin,
                        destinationAddress: direccionDestino
                    };

                    io.to(pEmail).emit("trip_details_updated", payloadCompleto);
                    io.to(tEmail).emit("trip_details_updated", payloadCompleto);

                    logMotor("end_trip",
                        `Dirección destino actualizada: ${direccionDestino}`,
                        "INFO"
                    );
                })
                .catch(err => logMotor("end_trip",
                    `Error en geocoding de destino: ${err}`,
                    "ERROR"
                ));

        } catch (error) {
            // 🛡️ Asegurar que la sesión se cierre si hubo error
            if (session) {
                try {
                    await session.abortTransaction();
                    session.endSession();
                } catch (cleanupError) {
                    logMotor("end_trip",
                        `Error al limpiar sesión: ${cleanupError}`,
                        "ERROR"
                    );
                }
            }

            logMotor("end_trip",
                `Error al finalizar viaje para Pasajero=${pEmail} Taxista=${tEmail}: ${error}`,
                "ERROR"
            );
        }
    });



    // ============================================================
    // 🎯 LIMPIEZA AL DESCONECTAR - MANEJO DE RECONEXIÓN
    // ============================================================
    socket.on("disconnect", async (reason) => {
        logMotor("disconnect", `Socket desconectado: ${email} | Razón: ${reason}`, "INFO");

        // Para microcortes o reemplazo de sesión, el motor principal se encarga de conservar estado.
        // Solo notificamos a la contraparte cuando la salida fue voluntaria desde cliente.
        if (reason !== "client namespace disconnect") {
            return;
        }

        try {
            const posDoc = await Position.findOne({ email }).lean();

            if (!posDoc) return;

            // Si era taxista en camino, notificar al pasajero
            if (posDoc.role === "taxista" &&
                ["encamino", "asignado"].includes(posDoc.estado) &&
                posDoc.pasajeroAsignado) {

                io.to(posDoc.pasajeroAsignado).emit("taxi_disconnected", {
                    message: "El taxista se ha desconectado. Buscando otra unidad..."
                });

                await clearPendingTimeouts(posDoc.pasajeroAsignado, "taxista desconectado");

                // No relanzamos despacho aquí: el motor de microdrop conserva el estado
                // y evita que un reconnect/notificación duplique la cascada.
            }

            // Si era pasajero en viaje, notificar al taxista
            if (posDoc.role === "pasajero" &&
                ["encamino", "encurso"].includes(posDoc.estado) &&
                posDoc.taxistaAsignado) {

                io.to(posDoc.taxistaAsignado).emit("passenger_disconnected", {
                    message: "El pasajero se ha desconectado."
                });
            }

        } catch (error) {
            logMotor("disconnect",
                `Error al manejar desconexión de ${email}: ${error}`,
                "ERROR"
            );
        }

    });

};