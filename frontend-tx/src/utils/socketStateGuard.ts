const STATE_PRIORITY: Record<string, number> = {
    activo: 0,
    pendiente: 0,
    buscando: 1,
    asignado: 2,
    encamino: 3,
    encurso: 4,
    finalizado: 5,
    cancelado: 5,
    ocupado: 0,
    inactivo: 0,
    desconectado: 6,
};

const RESET_STATES = new Set(["activo", "pendiente", "buscando"]);
const FINAL_STATES = new Set(["finalizado", "cancelado"]);

export const shouldAcceptStateTransition = (currentState?: string | null, nextState?: string | null) => {
    const current = String(currentState || "").trim().toLowerCase();
    const next = String(nextState || "").trim().toLowerCase();

    if (!next) return false;
    if (current === next) return true;

    if (RESET_STATES.has(next) && FINAL_STATES.has(current)) {
        return true;
    }

    if (FINAL_STATES.has(current) && !FINAL_STATES.has(next) && next !== "activo") {
        return false;
    }

    const currentPriority = STATE_PRIORITY[current] ?? 0;
    const nextPriority = STATE_PRIORITY[next] ?? 0;

    return currentPriority <= nextPriority;
};
