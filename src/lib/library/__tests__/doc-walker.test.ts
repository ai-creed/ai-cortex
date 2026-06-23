// src/lib/library/__tests__/doc-walker.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkDocs, DEFAULT_MAX_BYTES } from "../doc-walker.js";

describe("walkDocs", () => {
	let root: string;
	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lib-walk-")));
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	function write(rel: string, content: string | Buffer = "x") {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}

	it("includes doc extensions and prunes dependency/build/vcs dirs", async () => {
		write("README.md");
		write("docs/guide.mdx");
		write("notes.txt");
		write("node_modules/pkg/readme.md");
		write("dist/out.md");
		write(".git/config.md");
		write("release/mac-arm64/app/license.md");
		write(".worktrees/devel/docs/copy.md");
		write("src/code.ts");
		const { files } = await walkDocs(root);
		expect(files).toContain("README.md");
		expect(files).toContain("docs/guide.mdx");
		expect(files).toContain("notes.txt");
		expect(files).not.toContain("node_modules/pkg/readme.md");
		expect(files).not.toContain("dist/out.md");
		expect(files).not.toContain(".git/config.md");
		expect(files).not.toContain("release/mac-arm64/app/license.md"); // built output
		expect(files).not.toContain(".worktrees/devel/docs/copy.md"); // git worktree dupes
		expect(files).not.toContain("src/code.ts");
		expect(files).toEqual([...files].sort()); // sorted
	});

	it("excludes default secret-bearing patterns", async () => {
		write(".env.md");
		write("my-secret-notes.md");
		write("server.key.md");
		write("ok.md");
		const { files } = await walkDocs(root);
		expect(files).toEqual(["ok.md"]);
	});

	it("lets an owner include glob override a default secret exclude", async () => {
		write(".env.md", "blocked"); // secret + doc ext, no include -> excluded
		write("safe/.env.sample", "allowed"); // secret pattern, but owner opts it in
		write("nope/passwords.key.md", "x"); // secret, not included -> excluded
		const { files } = await walkDocs(root, {
			includeGlobs: ["safe/.env.sample"],
		});
		expect(files).toContain("safe/.env.sample");
		expect(files).not.toContain(".env.md");
		expect(files).not.toContain("nope/passwords.key.md");
	});

	it("honors owner include and exclude globs", async () => {
		write("keep/a.md");
		write("drop/b.md");
		write("data/extra.rst"); // rst is already a doc ext, but test include of a non-default ext
		write("data/notes.log");
		const { files } = await walkDocs(root, {
			includeGlobs: ["data/**/*.log"],
			excludeGlobs: ["drop/**"],
		});
		expect(files).toContain("keep/a.md");
		expect(files).toContain("data/notes.log"); // pulled in by includeGlob
		expect(files).not.toContain("drop/b.md");
	});

	it("skips oversize files and symlinks with a recorded reason", async () => {
		write("big.md", "a".repeat(DEFAULT_MAX_BYTES + 1));
		write("small.md", "ok");
		fs.symlinkSync(path.join(root, "small.md"), path.join(root, "link.md"));
		const { files, skipped } = await walkDocs(root);
		expect(files).toContain("small.md");
		expect(files).not.toContain("big.md");
		expect(files).not.toContain("link.md");
		expect(skipped).toContainEqual({ relPath: "big.md", reason: "oversize" });
		expect(skipped).toContainEqual({ relPath: "link.md", reason: "symlink" });
	});

	it("skips binary and non-UTF8 files with a recorded reason", async () => {
		write("bin.md", Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02])); // NUL byte -> binary
		write("latin1.md", Buffer.from([0x68, 0x69, 0xff, 0xfe])); // invalid UTF-8 lead byte
		write("good.md", "clean text");
		const { files, skipped } = await walkDocs(root);
		expect(files).toEqual(["good.md"]);
		expect(skipped).toContainEqual({ relPath: "bin.md", reason: "binary" });
		expect(skipped).toContainEqual({
			relPath: "latin1.md",
			reason: "non-utf8",
		});
	});
});
