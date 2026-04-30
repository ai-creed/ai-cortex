import { validate } from "../utils/validation.js";

export function validateCreateUser(body: unknown): {
	email: string;
	password: string;
	name: string;
} {
	const b = body as Record<string, unknown>;
	validate(typeof b.email === "string", "email required");
	validate(typeof b.password === "string", "password required");
	validate(typeof b.name === "string", "name required");
	return b as { email: string; password: string; name: string };
}

export function validateCreatePost(body: unknown): {
	title: string;
	body: string;
} {
	const b = body as Record<string, unknown>;
	validate(typeof b.title === "string", "title required");
	validate(typeof b.body === "string", "body required");
	return b as { title: string; body: string };
}
