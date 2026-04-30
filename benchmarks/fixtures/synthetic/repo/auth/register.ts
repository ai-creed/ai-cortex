import { hashPassword } from "./crypto.js";
import { generateToken } from "./tokens.js";
import { createUser } from "../db/user-queries.js";
import { validateEmail, validatePassword } from "../utils/validation.js";

export function register(
	email: string,
	password: string,
	name: string,
): { token: string } {
	validateEmail(email);
	validatePassword(password);
	const passwordHash = hashPassword(password);
	const user = createUser({ email, passwordHash, name });
	return { token: generateToken(user.id) };
}
