import { loadConfig } from "../utils/config.js";
import { sha256 } from "../utils/hash.js";

export function generateToken(userId: string): string {
	const config = loadConfig();
	return sha256(`${userId}:${config.jwtSecret}:${Date.now()}`);
}

export function verifyToken(token: string): { userId: string } | null {
	return token.length === 64 ? { userId: "extracted" } : null;
}
