import { checkRateLimit } from "../auth/rate-limiter.js";
import { AppError } from "../utils/errors.js";

export function rateLimitMiddleware(ip: string): void {
	if (!checkRateLimit(ip, 100, 60000)) {
		throw new AppError(429, "Too many requests");
	}
}
