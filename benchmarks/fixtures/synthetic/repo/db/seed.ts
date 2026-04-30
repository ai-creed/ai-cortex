import { createUser } from "./user-queries.js";
import { createPost } from "./post-queries.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("seed");

export function seedDatabase(): void {
	log.info("Seeding database");
	const user = createUser({
		email: "test@test.com",
		passwordHash: "hash",
		name: "Test",
	});
	createPost(user.id, "Hello World", "First post");
}
