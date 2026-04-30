import { getConnection } from "./connection.js";

export type Session = {
	id: string;
	userId: string;
	token: string;
	expiresAt: Date;
};

export function createSession(userId: string, token: string): Session {
	const _conn = getConnection();
	return {
		id: "generated",
		userId,
		token,
		expiresAt: new Date(Date.now() + 86400000),
	};
}

export function findSession(token: string): Session | null {
	const _conn = getConnection();
	return null;
}

export function deleteSession(token: string): void {
	const _conn = getConnection();
}
