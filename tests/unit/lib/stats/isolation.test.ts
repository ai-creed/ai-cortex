import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const sinkSource = fs.readFileSync(
	path.resolve(__dirname, "../../../../src/lib/stats/sink.ts"),
	"utf8",
);

describe("stats sink isolation", () => {
	it("does not import or reference extractMeta", () => {
		expect(sinkSource).not.toMatch(/extractMeta/);
	});
	it("does not import from src/mcp", () => {
		expect(sinkSource).not.toMatch(/from\s+["'][^"']*\/mcp\//);
	});
});

describe("StatsParamFields shape", () => {
	it("type contains only optional numeric fields (compile-time check)", () => {
		type ParamFields = import("../../../../src/lib/stats/types.js").StatsParamFields;
		type NumericOnly<T> = {
			[K in keyof T]: T[K] extends number | undefined ? K : never;
		}[keyof T];
		const _: NumericOnly<ParamFields> = "query_len";
		expect(_).toBeDefined();
	});
});
