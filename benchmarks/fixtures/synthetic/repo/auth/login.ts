import { findUserByEmail } from "../db/user-queries.js";
import { verifyPassword } from "./crypto.js";
import { generateToken } from "./tokens.js";
import { createSession } from "../db/session-queries.js";
import { AuthError } from "../utils/errors.js";

export function login(email: string, password: string): { token: string } {
	const user = findUserByEmail(email);
	if (!user) throw new AuthError("Invalid credentials");
	if (!verifyPassword(password, user.passwordHash)) throw new AuthError("Invalid credentials");
	const token = generateToken(user.id);
	createSession(user.id, token);
	return { token };
}
