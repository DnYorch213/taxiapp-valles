/**
 * 🎯 CONSTANTES DE ESTADOS - Fuente única de verdad
 * Todos los estados del sistema están definidos aquí
 */

// ========== ESTADOS DE POSICIÓN (Taxistas y Pasajeros en tiempo real) ==========
export const POSITION_STATES = {
  // Taxista: disponible y buscando clientes
  ACTIVO: "activo",
  
  // Pasajero: buscando un taxi
  BUSCANDO: "buscando",
  
  // Estado temporal: Taxista ha sido asignado pero pasajero aún no confirmó
  PREASIGNADO: "preasignado",
  
  // Taxista: asignado a un pasajero (esperando que suba)
  ASIGNADO: "asignado",
  
  // Ambos: Taxista en ruta hacia pasajero (aún no lo ha recogido)
  ENCAMINO: "encamino",
  
  // Ambos: El pasajero ya está en el taxi, viaje en curso
  ENCURSO: "encurso",
  
  // Viaje finalizado
  FINALIZADO: "finalizado",
  
  // Viaje cancelado
  CANCELADO: "cancelado",
} as const;

// ========== ESTADOS DE VIAJE (Solo para historial en Trip collection) ==========
// Nota: Trip solo almacena viajes COMPLETADOS, por eso algunos estados son diferentes
export const TRIP_STATES = {
  PENDIENTE: "pendiente",       // Inicial
  ASIGNADO: "asignado",         // Taxista asignado
  ENCAMINO: "encamino",         // En ruta
  ENCURSO: "encurso",           // Pasajero dentro del taxi
  FINALIZADO: "finalizado",     // Completado
  CANCELADO: "cancelado",        // Cancelado
} as const;

// ========== TIPOS HELPER ==========
export type PositionState = typeof POSITION_STATES[keyof typeof POSITION_STATES];
export type TripState = typeof TRIP_STATES[keyof typeof TRIP_STATES];

// ========== ARRAYS PARA VALIDACIONES ==========
export const VALID_POSITION_STATES = Object.values(POSITION_STATES);
export const VALID_TRIP_STATES = Object.values(TRIP_STATES);

// ========== TRANSICIONES VÁLIDAS ==========
// Define qué estados pueden transicionar a cuáles
export const STATE_TRANSITIONS: Record<PositionState, PositionState[]> = {
  [POSITION_STATES.ACTIVO]: [POSITION_STATES.ASIGNADO],
  [POSITION_STATES.BUSCANDO]: [POSITION_STATES.PREASIGNADO, POSITION_STATES.CANCELADO],
  [POSITION_STATES.PREASIGNADO]: [POSITION_STATES.ASIGNADO, POSITION_STATES.CANCELADO],
  [POSITION_STATES.ASIGNADO]: [POSITION_STATES.ENCAMINO, POSITION_STATES.ACTIVO],
  [POSITION_STATES.ENCAMINO]: [POSITION_STATES.ENCURSO, POSITION_STATES.ACTIVO, POSITION_STATES.CANCELADO],
  [POSITION_STATES.ENCURSO]: [POSITION_STATES.FINALIZADO, POSITION_STATES.CANCELADO],
  [POSITION_STATES.FINALIZADO]: [POSITION_STATES.ACTIVO],
  [POSITION_STATES.CANCELADO]: [POSITION_STATES.ACTIVO, POSITION_STATES.BUSCANDO],
};

// ========== STATE GROUPS ==========
// Agrupa estados por categoría para queries más limpias
export const STATE_GROUPS = {
  // Estados cuando el taxi está ocupado
  OCCUPIED: [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO] as const,
  
  // Estados de viaje activo (cualquier punto del trayecto)
  ACTIVE_TRIP: [POSITION_STATES.PREASIGNADO, POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO] as const,
  
  // Estados disponibles para recibir viajes
  AVAILABLE: [POSITION_STATES.ACTIVO] as const,
  
  // Estados finales de viaje
  FINAL_STATES: [POSITION_STATES.FINALIZADO, POSITION_STATES.CANCELADO] as const,
} as const;

// ========== VALIDADORES ==========
export function isValidPositionState(state: string): state is PositionState {
  return VALID_POSITION_STATES.includes(state as PositionState);
}

export function isValidTripState(state: string): state is TripState {
  return VALID_TRIP_STATES.includes(state as TripState);
}

export function canTransitionTo(from: PositionState, to: PositionState): boolean {
  return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isOccupied(state: PositionState): boolean {
  return STATE_GROUPS.OCCUPIED.includes(state as any);
}

export function isActiveTip(state: PositionState): boolean {
  return STATE_GROUPS.ACTIVE_TRIP.includes(state as any);
}

export function isFinalState(state: PositionState): boolean {
  return STATE_GROUPS.FINAL_STATES.includes(state as any);
}
