import { createLogger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";

const log = createLogger("db");

let pool: unknown = null;

export function getConnection(): unknown {
	if (!pool) {
		const config = loadConfig();
		log.info(`Connecting to ${config.dbUrl}`);
		pool = { connected: true, url: config.dbUrl };
	}
	return pool;
}

export function closeConnection(): void {
	pool = null;
	log.info("Connection closed");
}
