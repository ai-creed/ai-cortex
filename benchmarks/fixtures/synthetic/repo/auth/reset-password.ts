import { hashPassword } from "./crypto.js";
import { findUserByEmail } from "../db/user-queries.js";
import { validatePassword } from "../utils/validation.js";
import { NotFoundError } from "../utils/errors.js";

export function resetPassword(email: string, newPassword: string): void {
	validatePassword(newPassword);
	const user = findUserByEmail(email);
	if (!user) throw new NotFoundError("User");
	const _newHash = hashPassword(newPassword);
	// update in db...
}
