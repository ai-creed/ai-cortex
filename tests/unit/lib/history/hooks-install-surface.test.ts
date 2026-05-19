import { describe, it, expect } from "vitest";
import {
	applySurfaceInstall,
	applySurfaceUninstall,
	SURFACE_HOOK_MARKER,
} from "../../../../src/lib/history/hooks-install.js";

describe("surface hook install (Claude)", () => {
	it("adds a PreToolUse entry with matcher and 5s timeout", () => {
		const next = applySurfaceInstall({});
		const entries = (next.hooks?.PreToolUse ?? []) as Array<{
			matcher: string;
			hooks: Array<{ command: string; timeout?: number }>;
		}>;
		const mine = entries.find((e) =>
			e.hooks.some((h) => h.command.includes(SURFACE_HOOK_MARKER)),
		);
		expect(mine).toBeDefined();
		expect(mine!.matcher).toBe("Edit|Write|MultiEdit");
		expect(mine!.hooks[0]!.timeout).toBe(5);
	});

	it("is idempotent", () => {
		const once = applySurfaceInstall({});
		const twice = applySurfaceInstall(once);
		expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
	});

	it("uninstall removes only the surface entry, keeps other hooks", () => {
		const base = {
			hooks: {
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command" as const, command: "other" }] },
				],
			},
		};
		const installed = applySurfaceInstall(base);
		const removed = applySurfaceUninstall(installed);
		const pre = (removed.hooks?.PreToolUse ?? []) as Array<{
			hooks: Array<{ command: string }>;
		}>;
		expect(
			pre.some((e) => e.hooks.some((h) => h.command.includes(SURFACE_HOOK_MARKER))),
		).toBe(false);
		expect(pre.some((e) => e.hooks.some((h) => h.command === "other"))).toBe(true);
	});

	it("does NOT add a Codex PreToolUse group in v1 (fixture-gated)", () => {
		expect(SURFACE_HOOK_MARKER).toBe("ai-cortex memory surface-hook");
	});
});
