const TOAST_SYNC_KEY = "valles:toast:last";
const DEFAULT_COOLDOWN_MS = 2500;

const state = new Map<string, number>();
let initialized = false;

const readState = () => {
    if (typeof window === "undefined") return;
    try {
        const raw = window.localStorage.getItem(TOAST_SYNC_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, number>;
        Object.entries(parsed).forEach(([key, ts]) => {
            if (Number.isFinite(ts)) {
                state.set(key, ts);
            }
        });
    } catch {
        // ignore invalid cache
    }
};

const persistState = () => {
    if (typeof window === "undefined") return;
    const snapshot = Object.fromEntries(state.entries());
    window.localStorage.setItem(TOAST_SYNC_KEY, JSON.stringify(snapshot));
};

const pruneState = (now: number, cooldownMs: number) => {
    for (const [key, ts] of Array.from(state.entries())) {
        if (now - ts >= cooldownMs * 2) {
            state.delete(key);
        }
    }
};

const ensureListener = () => {
    if (typeof window === "undefined" || initialized) return;
    initialized = true;
    readState();

    window.addEventListener("storage", (event) => {
        if (event.key !== TOAST_SYNC_KEY || !event.newValue) return;
        try {
            const parsed = JSON.parse(event.newValue) as Record<string, number>;
            Object.entries(parsed).forEach(([key, ts]) => {
                if (Number.isFinite(ts)) {
                    state.set(key, ts);
                }
            });
        } catch {
            // ignore invalid payload
        }
    });
};

export const showToastOnce = (
    key: string,
    toastFn: () => void,
    options?: { cooldownMs?: number }
) => {
    if (typeof window === "undefined") {
        toastFn();
        return;
    }

    ensureListener();

    const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const now = Date.now();
    pruneState(now, cooldownMs);

    const lastSeen = state.get(key) ?? 0;
    if (now - lastSeen < cooldownMs) {
        return;
    }

    state.set(key, now);
    persistState();
    toastFn();
};
