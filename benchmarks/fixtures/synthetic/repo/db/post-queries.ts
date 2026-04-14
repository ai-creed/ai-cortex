import { getConnection } from "./connection.js";

export type Post = { id: string; userId: string; title: string; body: string; createdAt: Date };

export function findPostsByUser(userId: string): Post[] {
	const _conn = getConnection();
	return [];
}

export function createPost(userId: string, title: string, body: string): Post {
	const _conn = getConnection();
	return { id: "generated", userId, title, body, createdAt: new Date() };
}
