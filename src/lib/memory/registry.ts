import fs from "node:fs/promises";
import path from "node:path";

export const BUILT_IN_TYPES = ["decision", "gotcha", "pattern", "how-to"] as const;
export type BuiltInType = (typeof BUILT_IN_TYPES)[number];

export type ExtraFieldSpec = string | string[];

export type TypeSpec = {
	builtIn: boolean;
	bodySections?: string[];
	extraFrontmatter?: Record<string, ExtraFieldSpec>;
	auditPreserveBody?: boolean;
};

export type TypeRegistry = {
	version: number;
	types: Record<string, TypeSpec>;
};

export const REGISTRY_VERSION = 1;

const SEED: TypeRegistry = {
	version: REGISTRY_VERSION,
	types: {
		decision: {
			builtIn: true,
			bodySections: ["Rule", "Why", "Alternatives considered"],
			auditPreserveBody: true,
		},
		gotcha: {
			builtIn: true,
			extraFrontmatter: { severity: ["info", "warning", "critical"] },
			bodySections: ["Symptom", "Cause", "Workaround", "How to detect"],
		},
		pattern: {
			builtIn: true,
			bodySections: ["Where", "Convention", "Examples"],
		},
		"how-to": {
			builtIn: true,
			bodySections: ["Goal", "Steps", "Verification"],
		},
	},
};

function registryPath(memoryRoot: string): string {
	return path.join(memoryRoot, "types.json");
}

export async function ensureRegistry(memoryRoot: string): Promise<void> {
	await fs.mkdir(memoryRoot, { recursive: true });
	const p = registryPath(memoryRoot);
	try {
		await fs.access(p);
		return;
	} catch {
		await fs.writeFile(p, JSON.stringify(SEED, null, 2) + "\n");
	}
}

export async function readRegistry(memoryRoot: string): Promise<TypeRegistry> {
	const text = await fs.readFile(registryPath(memoryRoot), "utf8");
	return JSON.parse(text) as TypeRegistry;
}

export type ValidationInput = {
	type: string;
	typeFields?: Record<string, unknown>;
};

export type ValidationResult =
	| { ok: true }
	| { ok: false; errors: string[] };

export function validateRegistration(reg: TypeRegistry, input: ValidationInput): ValidationResult {
	const spec = reg.types[input.type];
	if (!spec) return { ok: false, errors: [`unregistered type: ${input.type}`] };

	const errors: string[] = [];
	const extras = spec.extraFrontmatter ?? {};
	const got = input.typeFields ?? {};

	for (const [field, fieldSpec] of Object.entries(extras)) {
		const optional = typeof fieldSpec === "string" && fieldSpec.endsWith("?");
		if (!(field in got)) {
			if (!optional) errors.push(`required field missing: ${field}`);
			continue;
		}
		if (Array.isArray(fieldSpec)) {
			if (!fieldSpec.includes(got[field] as string)) {
				errors.push(`field ${field} must be one of [${fieldSpec.join(", ")}], got ${JSON.stringify(got[field])}`);
			}
		}
	}
	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
