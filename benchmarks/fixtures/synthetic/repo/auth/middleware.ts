import { verifyToken } from "./tokens.js";
import { AuthError } from "../utils/errors.js";

export type AuthContext = { userId: string };

export function requireAuth(token: string | undefined): AuthContext {
	if (!token) throw new AuthError("No token provided");
	const payload = verifyToken(token);
	if (!payload) throw new AuthError("Invalid token");
	return { userId: payload.userId };
}
