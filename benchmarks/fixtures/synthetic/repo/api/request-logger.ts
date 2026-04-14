import { createLogger } from "../utils/logger.js";

const log = createLogger("api:request");

export function logRequest(method: string, path: string, durationMs: number): void {
	log.info(`${method} ${path} ${durationMs}ms`);
}
