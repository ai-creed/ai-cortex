export type ApiResponse<T> = {
	success: boolean;
	data?: T;
	error?: string;
};

export function success<T>(data: T): ApiResponse<T> {
	return { success: true, data };
}

export function failure(message: string): ApiResponse<never> {
	return { success: false, error: message };
}
