export class AppError extends Error {
	constructor(
		public statusCode: number,
		message: string,
	) {
		super(message);
		this.name = "AppError";
	}
}

export class ValidationError extends AppError {
	constructor(message: string) {
		super(400, message);
		this.name = "ValidationError";
	}
}

export class NotFoundError extends AppError {
	constructor(resource: string) {
		super(404, `${resource} not found`);
		this.name = "NotFoundError";
	}
}

export class AuthError extends AppError {
	constructor(message: string) {
		super(401, message);
		this.name = "AuthError";
	}
}
