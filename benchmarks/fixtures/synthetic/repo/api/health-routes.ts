import { checkDbHealth } from "../db/health.js";

export function handleHealthCheck(): { status: string; db: boolean } {
	return { status: "ok", db: checkDbHealth() };
}
