import { findUserById } from "../db/user-queries.js";
import { requireAuth } from "../auth/middleware.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("api:profile");

export function getUserProfile(token: string): {
	id: string;
	email: string;
	name: string;
} {
	const auth = requireAuth(token);
	log.info(`Getting profile for ${auth.userId}`);
	const user = findUserById(auth.userId);
	return { id: user.id, email: user.email, name: user.name };
}
