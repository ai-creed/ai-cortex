import { register } from "../auth/register.js";
import { resetPassword } from "../auth/reset-password.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("api:users");

export function handleUserCreate(body: { email: string; password: string; name: string }): { token: string } {
	log.info(`Creating user: ${body.email}`);
	return register(body.email, body.password, body.name);
}

export function handlePasswordReset(body: { email: string; newPassword: string }): void {
	log.info(`Password reset: ${body.email}`);
	resetPassword(body.email, body.newPassword);
}
