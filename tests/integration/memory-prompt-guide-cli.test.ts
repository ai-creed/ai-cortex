import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	runMemoryInstallPromptGuide,
	runMemoryUninstallPromptGuide,
} from "../../src/lib/memory/cli/install-prompt-guide.js";

let home: string;
let cwd: string;
let stdoutLines: string[];
const stdout = {
	write: (s: string): boolean => {
		stdoutLines.push(s);
		return true;
	},
};

beforeEach(() => {
	home = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "promptguide-home-")),
	);
	cwd = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "promptguide-cwd-")),
	);
	stdoutLines = [];
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

describe("install-prompt-guide", () => {
	it("default scope=global writes to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md", async () => {
		const code = await runMemoryInstallPromptGuide([], { cwd, home, stdout });
		expect(code).toBe(0);
		const claudeMd = fs.readFileSync(
			path.join(home, ".claude", "CLAUDE.md"),
			"utf8",
		);
		const codexMd = fs.readFileSync(
			path.join(home, ".codex", "AGENTS.md"),
			"utf8",
		);
		expect(claudeMd).toContain("recall_memory");
		expect(claudeMd).toContain("get_memory");
		expect(codexMd).toContain("recall_memory");
	});

	it("scope=project requires --yes confirmation", async () => {
		const code = await runMemoryInstallPromptGuide(["--scope", "project"], {
			cwd,
			home,
			stdout,
		});
		expect(code).toBe(1);
		expect(fs.existsSync(path.join(cwd, "CLAUDE.md"))).toBe(false);
	});

	it("scope=project --yes writes to <cwd>/CLAUDE.md and <cwd>/AGENTS.md", async () => {
		const code = await runMemoryInstallPromptGuide(
			["--scope", "project", "--yes"],
			{ cwd, home, stdout },
		);
		expect(code).toBe(0);
		expect(fs.existsSync(path.join(cwd, "CLAUDE.md"))).toBe(true);
		expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(true);
	});

	it("agent=claude only writes Claude config", async () => {
		await runMemoryInstallPromptGuide(["--agent", "claude"], {
			cwd,
			home,
			stdout,
		});
		expect(fs.existsSync(path.join(home, ".claude", "CLAUDE.md"))).toBe(true);
		expect(fs.existsSync(path.join(home, ".codex", "AGENTS.md"))).toBe(false);
	});

	it("agent=codex only writes Codex config", async () => {
		await runMemoryInstallPromptGuide(["--agent", "codex"], {
			cwd,
			home,
			stdout,
		});
		expect(fs.existsSync(path.join(home, ".claude", "CLAUDE.md"))).toBe(false);
		expect(fs.existsSync(path.join(home, ".codex", "AGENTS.md"))).toBe(true);
	});

	it("idempotent: running twice does not duplicate the block", async () => {
		await runMemoryInstallPromptGuide([], { cwd, home, stdout });
		await runMemoryInstallPromptGuide([], { cwd, home, stdout });
		const md = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
		const occurrences = md.match(/<!-- ai-cortex:memory-rule:start/g) ?? [];
		expect(occurrences.length).toBe(1);
	});

	it("preserves existing CLAUDE.md content when appending", async () => {
		const existing = "# My project\n\nExisting guidance.\n";
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), existing);

		await runMemoryInstallPromptGuide(["--agent", "claude"], {
			cwd,
			home,
			stdout,
		});
		const md = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
		expect(md.startsWith("# My project")).toBe(true);
		expect(md).toContain("Existing guidance.");
		expect(md).toContain("ai-cortex:memory-rule:start");
	});

	it("upgrades older version blocks in place", async () => {
		const existing = `# Project\n\n<!-- ai-cortex:memory-rule:start v0 -->\nOld content here.\n<!-- ai-cortex:memory-rule:end -->\n`;
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), existing);

		await runMemoryInstallPromptGuide(["--agent", "claude"], {
			cwd,
			home,
			stdout,
		});
		const md = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
		expect(md).not.toContain("Old content here.");
		expect(md).toContain("recall_memory");
		expect(md).toMatch(/<!-- ai-cortex:memory-rule:start v\d+ -->/);
	});
});

describe("uninstall-prompt-guide", () => {
	it("removes the block when present", async () => {
		await runMemoryInstallPromptGuide([], { cwd, home, stdout });
		stdoutLines = [];
		const code = await runMemoryUninstallPromptGuide([], {
			cwd,
			home,
			stdout,
		});
		expect(code).toBe(0);
		const md = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
		expect(md).not.toContain("ai-cortex:memory-rule");
	});

	it("no-op when block absent (file exists with other content)", async () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".claude", "CLAUDE.md"),
			"# My project\n",
		);
		const code = await runMemoryUninstallPromptGuide([], {
			cwd,
			home,
			stdout,
		});
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toContain("no block present");
	});

	it("no-op when file does not exist", async () => {
		const code = await runMemoryUninstallPromptGuide([], {
			cwd,
			home,
			stdout,
		});
		expect(code).toBe(0);
		expect(stdoutLines.join("")).toContain("does not exist");
	});

	it("scope=project requires --yes", async () => {
		const code = await runMemoryUninstallPromptGuide(["--scope", "project"], {
			cwd,
			home,
			stdout,
		});
		expect(code).toBe(1);
	});

	it("preserves surrounding content when removing block", async () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".claude", "CLAUDE.md"),
			"# Header\n",
		);
		await runMemoryInstallPromptGuide(["--agent", "claude"], {
			cwd,
			home,
			stdout,
		});
		await runMemoryUninstallPromptGuide(["--agent", "claude"], {
			cwd,
			home,
			stdout,
		});
		const md = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
		expect(md).toContain("# Header");
		expect(md).not.toContain("ai-cortex:memory-rule");
	});
});
