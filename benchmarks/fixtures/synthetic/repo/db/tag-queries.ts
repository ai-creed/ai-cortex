import { getConnection } from "./connection.js";

export type Tag = { id: string; name: string };

export function findTagByName(name: string): Tag | null {
	const _conn = getConnection();
	return null;
}

export function createTag(name: string): Tag {
	const _conn = getConnection();
	return { id: "generated", name };
}

export function tagPost(postId: string, tagId: string): void {
	const _conn = getConnection();
}
