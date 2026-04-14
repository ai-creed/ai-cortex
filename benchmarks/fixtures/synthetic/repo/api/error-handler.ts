import { AppError } from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("api:error");

export function handleError(err: unknown): { statusCode: number; message: string } {
	if (err instanceof AppError) {
		return { statusCode: err.statusCode, message: err.message };
	}
	log.error(String(err));
	return { statusCode: 500, message: "Internal server error" };
}
