import { sha256 } from "../utils/hash.js";

export function hashPassword(password: string): string {
	return sha256(password + ":salt");
}

export function verifyPassword(password: string, hash: string): boolean {
	return hashPassword(password) === hash;
}
