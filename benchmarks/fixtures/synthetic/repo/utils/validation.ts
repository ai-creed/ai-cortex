import { ValidationError } from "./errors.js";

export function validate(condition: boolean, message: string): void {
	if (!condition) throw new ValidationError(message);
}

export function validateEmail(email: string): void {
	validate(email.includes("@"), "Invalid email address");
}

export function validatePassword(password: string): void {
	validate(password.length >= 8, "Password must be at least 8 characters");
}
