import { getConnection } from "./connection.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("migrations");

export type Migration = { name: string; up: () => void; down: () => void };

export function runMigrations(migrations: Migration[]): void {
	const _conn = getConnection();
	for (const m of migrations) {
		log.info(`Running migration: ${m.name}`);
		m.up();
	}
}
