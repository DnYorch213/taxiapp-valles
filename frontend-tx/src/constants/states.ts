// Frontend state constants - mirrored from backend for consistency
// These represent the estado field used in Position and Trip models

export const POSITION_STATES = {
    ACTIVO: "activo",
    BUSCANDO: "buscando",
    PREASIGNADO: "preasignado",
    ASIGNADO: "asignado",
    ENCAMINO: "encamino",
    ENCURSO: "encurso",
    FINALIZADO: "finalizado",
    CANCELADO: "cancelado",
} as const;

export const TRIP_STATES = {
    PENDIENTE: "pendiente",
    BUSCANDO: "buscando",
    ASIGNADO: "asignado",
    ENCAMINO: "encamino",
    ENCURSO: "encurso",
    FINALIZADO: "finalizado",
    CANCELADO: "cancelado",
} as const;

// Grouped states for common UI patterns
export const STATE_GROUPS = {
    // Taxi is available/ready
    AVAILABLE: [POSITION_STATES.ACTIVO, POSITION_STATES.BUSCANDO],

    // Trip is actively happening (passenger inside taxi)
    ACTIVE_TRIP: [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO],

    // Taxi is occupied/in use
    OCCUPIED: [POSITION_STATES.PREASIGNADO, POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO],

    // Final terminal states
    FINAL_STATES: [POSITION_STATES.FINALIZADO, POSITION_STATES.CANCELADO],
} as const;

// UI-specific state groups for display logic
export const TAXI_DISPLAY_STATES = {
    CONNECTED: [POSITION_STATES.ACTIVO, POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO],
    DISCONNECTED: ["desconectado"],
    INACTIVE: ["inactivo"],
} as const;

export const PASSENGER_DISPLAY_STATES = {
    LOOKING: [POSITION_STATES.BUSCANDO, POSITION_STATES.PREASIGNADO],
    IN_TRIP: [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO],
    COMPLETED: [POSITION_STATES.FINALIZADO],
    CANCELLED: [POSITION_STATES.CANCELADO],
} as const;

// Type definitions for TypeScript
export type PositionState = typeof POSITION_STATES[keyof typeof POSITION_STATES];
export type TripState = typeof TRIP_STATES[keyof typeof TRIP_STATES];
export type ViajEstado = typeof TRIP_STATES[keyof typeof TRIP_STATES];
