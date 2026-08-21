export type LogLevel = "INFO" | "WARN" | "ERROR";

const LEVEL_COLORS: Record<LogLevel, string> = {
    INFO: "\x1b[36m",
    WARN: "\x1b[33m",
    ERROR: "\x1b[31m"
};

const RESET = "\x1b[0m";

export function logMotor(event: string, details: string, level: LogLevel = "INFO") {
    const timestamp = new Date().toISOString();
    const color = LEVEL_COLORS[level] || "";
    console.log(`${color}[${level}][${event}] ${timestamp} :: ${details}${RESET}`);
}
