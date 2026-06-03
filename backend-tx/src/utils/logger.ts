export type LogLevel = "INFO" | "WARN" | "ERROR";

export function logMotor(event: string, details: string, level: LogLevel = "INFO") {
    const timestamp = new Date().toISOString();
    console.log(`[Motor][${event}][${level}] ${timestamp} :: ${details}`);
}
