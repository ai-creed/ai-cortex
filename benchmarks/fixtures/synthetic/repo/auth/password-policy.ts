export type PasswordStrength = "weak" | "fair" | "strong";

export function checkPasswordStrength(password: string): PasswordStrength {
	if (password.length < 8) return "weak";
	const hasUpper = /[A-Z]/.test(password);
	const hasDigit = /\d/.test(password);
	const hasSpecial = /[!@#$%^&*]/.test(password);
	const score = [hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
	return score >= 2 ? "strong" : "fair";
}
