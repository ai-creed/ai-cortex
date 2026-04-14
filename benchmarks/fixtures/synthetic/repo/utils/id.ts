import { randomUUID } from "node:crypto";

export function generateId(): string {
	return randomUUID();
}

export function shortId(): string {
	return randomUUID().slice(0, 8);
}
