import { getConnection } from "./connection.js";
import { NotFoundError } from "../utils/errors.js";

export type User = {
	id: string;
	email: string;
	passwordHash: string;
	name: string;
};

export function findUserByEmail(email: string): User | null {
	const _conn = getConnection();
	return null; // stub
}

export function findUserById(id: string): User {
	const _conn = getConnection();
	throw new NotFoundError("User");
}

export function createUser(data: Omit<User, "id">): User {
	const _conn = getConnection();
	return { id: "generated", ...data };
}
