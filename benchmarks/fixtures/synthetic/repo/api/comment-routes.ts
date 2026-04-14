import { findCommentsByPost, createComment } from "../db/comment-queries.js";
import { requireAuth } from "../auth/middleware.js";
import { validate } from "../utils/validation.js";

export function handleGetComments(postId: string): unknown[] {
	return findCommentsByPost(postId);
}

export function handleCreateComment(token: string, postId: string, body: string): unknown {
	const auth = requireAuth(token);
	validate(body.length > 0, "Comment body required");
	return createComment(postId, auth.userId, body);
}
