import { createLogger } from "../utils/logger.js";
import { createUser } from "../db/user-queries.js";
import { generateToken } from "./tokens.js";
import { hashPassword } from "./crypto.js";

const log = createLogger("oauth");

export function handleOAuthCallback(provider: string, profile: { email: string; name: string }): { token: string } {
	log.info(`OAuth callback from ${provider}`);
	const passwordHash = hashPassword(profile.email + ":oauth");
	const user = createUser({ email: profile.email, passwordHash, name: profile.name });
	return { token: generateToken(user.id) };
}
