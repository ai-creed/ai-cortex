import { sha256 } from "../utils/hash.js";

export function generateOtp(secret: string): string {
	const time = Math.floor(Date.now() / 30000);
	return sha256(`${secret}:${time}`).slice(0, 6);
}

export function verifyOtp(secret: string, otp: string): boolean {
	return generateOtp(secret) === otp;
}
