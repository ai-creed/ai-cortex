export function createLogger(name: string) {
	return {
		info: (msg: string) => console.log(`[${name}] ${msg}`),
		error: (msg: string) => console.error(`[${name}] ${msg}`),
		warn: (msg: string) => console.warn(`[${name}] ${msg}`),
	};
}

export type Logger = ReturnType<typeof createLogger>;
