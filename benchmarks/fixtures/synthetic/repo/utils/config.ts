export type AppConfig = {
	port: number;
	dbUrl: string;
	jwtSecret: string;
	logLevel: string;
};

export function loadConfig(): AppConfig {
	return {
		port: Number(process.env.PORT) || 3000,
		dbUrl: process.env.DATABASE_URL || "postgres://localhost/app",
		jwtSecret: process.env.JWT_SECRET || "dev-secret",
		logLevel: process.env.LOG_LEVEL || "info",
	};
}
