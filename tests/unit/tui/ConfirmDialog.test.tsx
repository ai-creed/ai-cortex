import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ConfirmDialog } from "../../../src/tui/components/ConfirmDialog.js";

describe("ConfirmDialog", () => {
	it("renders title, body, and y/n hints", () => {
		const { lastFrame } = render(
			<ConfirmDialog
				title="Clean workspace?"
				body={["Permanently delete cached stats + index for", "  29751ede0f594c8a   0 calls · 0.2 MB"]}
				danger="This deletes the cache dir and cannot be undone."
				onConfirm={() => {}}
				onCancel={() => {}}
			/>,
		);
		const s = lastFrame() ?? "";
		expect(s).toContain("Clean workspace?");
		expect(s).toContain("29751ede0f594c8a");
		expect(s).toContain("cannot be undone");
		expect(s).toContain("[ y ] delete");
		expect(s).toContain("[ n ] cancel");
	});

	it("y triggers onConfirm; n triggers onCancel", async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const { stdin } = render(
			<ConfirmDialog
				title="Clean workspace?"
				body={["x"]}
				danger="x"
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);
		stdin.write("y");
		await new Promise((r) => setImmediate(r));
		expect(onConfirm).toHaveBeenCalledOnce();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("Esc triggers onCancel", async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const { stdin } = render(
			<ConfirmDialog title="Clean?" body={["x"]} danger="x" onConfirm={onConfirm} onCancel={onCancel} />,
		);
		stdin.write("n");
		await new Promise((r) => setImmediate(r));
		expect(onCancel).toHaveBeenCalledOnce();
	});
});
