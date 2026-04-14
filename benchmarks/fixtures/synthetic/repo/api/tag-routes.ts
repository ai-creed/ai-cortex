import { findTagByName, createTag, tagPost } from "../db/tag-queries.js";
import { requireAuth } from "../auth/middleware.js";
import { slugify } from "../utils/string.js";

export function handleTagPost(token: string, postId: string, tagName: string): void {
	requireAuth(token);
	const slug = slugify(tagName);
	let tag = findTagByName(slug);
	if (!tag) tag = createTag(slug);
	tagPost(postId, tag.id);
}
