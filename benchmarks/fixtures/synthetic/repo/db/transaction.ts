import { getConnection } from "./connection.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tx");

export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
	const _conn = getConnection();
	log.info("BEGIN");
	try {
		const result = await fn();
		log.info("COMMIT");
		return result;
	} catch (err) {
		log.info("ROLLBACK");
		throw err;
	}
}
