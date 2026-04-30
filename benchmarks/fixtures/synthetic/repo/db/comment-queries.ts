import { getConnection } from "./connection.js";

export type Comment = {
	id: string;
	postId: string;
	userId: string;
	body: string;
};

export function findCommentsByPost(postId: string): Comment[] {
	const _conn = getConnection();
	return [];
}

export function createComment(
	postId: string,
	userId: string,
	body: string,
): Comment {
	const _conn = getConnection();
	return { id: "generated", postId, userId, body };
}
