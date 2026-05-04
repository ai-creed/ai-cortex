// tests/unit/lib/repo-identity.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process");

import { execFileSync } from "node:child_process";
import { RepoIdentityError } from "../../../src/lib/models.js";
import { resolveRepoIdentity, validateWorktreePath } from "../../../src/lib/repo-identity.js";

const mockExec = vi.mocked(execFileSync);

describe("resolveRepoIdentity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns a 16-char repoKey and worktreeKey", () => {
		mockExec
			.mockReturnValueOnce("/home/user/project/.git\n" as any)
			.mockReturnValueOnce("/home/user/project\n" as any);

		const identity = resolveRepoIdentity("/home/user/project");

		expect(identity.repoKey).toHaveLength(16);
		expect(identity.worktreeKey).toHaveLength(16);
		expect(identity.gitCommonDir).toBe("/home/user/project/.git");
		expect(identity.worktreePath).toBe("/home/user/project");
	});

	it("two worktrees of the same repo share the same repoKey but differ in worktreeKey", () => {
		const sharedGit = "/home/user/project/.git";
		mockExec
			.mockReturnValueOnce(`${sharedGit}\n` as any)
			.mockReturnValueOnce("/home/user/project\n" as any);
		const a = resolveRepoIdentity("/home/user/project");

		mockExec
			.mockReturnValueOnce(`${sharedGit}\n` as any)
			.mockReturnValueOnce("/home/user/project-feature\n" as any);
		const b = resolveRepoIdentity("/home/user/project-feature");

		expect(a.repoKey).toBe(b.repoKey);
		expect(a.worktreeKey).not.toBe(b.worktreeKey);
	});

	it("throws RepoIdentityError when not a git repo", () => {
		mockExec.mockImplementation(() => {
			throw new Error("fatal: not a git repo");
		});
		expect(() => resolveRepoIdentity("/not/a/repo")).toThrow(RepoIdentityError);
	});

	it("throws RepoIdentityError when git is not installed", () => {
		const err = Object.assign(new Error("spawn git ENOENT"), {
			code: "ENOENT",
		});
		mockExec.mockImplementation(() => {
			throw err;
		});
		expect(() => resolveRepoIdentity("/any/path")).toThrow(RepoIdentityError);
	});
});

describe("validateWorktreePath", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vwp-"));
	});

	it("accepts an absolute existing directory", () => {
		expect(() => validateWorktreePath(tmp)).not.toThrow();
	});

	it("rejects a relative path", () => {
		expect(() => validateWorktreePath("relative/path")).toThrow(
			/absolute/i,
		);
	});

	it("rejects an empty string", () => {
		expect(() => validateWorktreePath("")).toThrow(/non-empty/i);
	});

	it("rejects a missing path", () => {
		const missing = path.join(tmp, "does-not-exist");
		expect(() => validateWorktreePath(missing)).toThrow(/exist/i);
	});

	it("rejects a file (not a directory)", () => {
		const file = path.join(tmp, "f.txt");
		fs.writeFileSync(file, "x");
		expect(() => validateWorktreePath(file)).toThrow(/directory/i);
	});

	it("rejects non-string input via runtime guard", () => {
		expect(() => validateWorktreePath(undefined as unknown as string)).toThrow();
		expect(() => validateWorktreePath(null as unknown as string)).toThrow();
	});
});
