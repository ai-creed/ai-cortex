import { findPostsByUser, createPost } from "../db/post-queries.js";
import { requireAuth } from "../auth/middleware.js";
import { validate } from "../utils/validation.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("api:posts");

export function handleGetPosts(token: string): unknown[] {
	const auth = requireAuth(token);
	return findPostsByUser(auth.userId);
}

export function handleCreatePost(
	token: string,
	title: string,
	body: string,
): unknown {
	const auth = requireAuth(token);
	validate(title.length > 0, "Title required");
	log.info(`Creating post by ${auth.userId}`);
	return createPost(auth.userId, title, body);
}
