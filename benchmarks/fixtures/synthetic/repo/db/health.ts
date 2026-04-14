import { getConnection } from "./connection.js";

export function checkDbHealth(): boolean {
	try {
		getConnection();
		return true;
	} catch {
		return false;
	}
}
