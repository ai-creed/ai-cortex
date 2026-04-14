export type CorsConfig = {
	origins: string[];
	methods: string[];
	allowHeaders: string[];
};

export function defaultCorsConfig(): CorsConfig {
	return {
		origins: ["*"],
		methods: ["GET", "POST", "PUT", "DELETE"],
		allowHeaders: ["Content-Type", "Authorization"],
	};
}

export function isOriginAllowed(origin: string, config: CorsConfig): boolean {
	return config.origins.includes("*") || config.origins.includes(origin);
}
