import { findSession, deleteSession } from "../db/session-queries.js";
import { AuthError } from "../utils/errors.js";

export function validateSession(token: string): { userId: string } {
	const session = findSession(token);
	if (!session) throw new AuthError("Session expired");
	if (session.expiresAt < new Date()) {
		deleteSession(token);
		throw new AuthError("Session expired");
	}
	return { userId: session.userId };
}

export function logout(token: string): void {
	deleteSession(token);
}
