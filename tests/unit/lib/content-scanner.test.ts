import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentScan } from "../../../src/lib/content-scanner.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "content-scan-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

describe("contentScan", () => {
  it("records class-name hits with line number", () => {
    write("a.ts", "export class CardEditor {\n  x = 1\n}\n");
    const res = contentScan(tmp, ["a.ts"], ["card", "editor"]);
    const hits = res.hits.get("a.ts");
    expect(hits).toBeDefined();
    expect(hits![0].line).toBe(1);
    expect(hits![0].snippet).toContain("CardEditor");
  });

  it("records JSX tag hits", () => {
    write("a.tsx", "export const X = () => (\n  <RightPanel />\n);\n");
    const res = contentScan(tmp, ["a.tsx"], ["rightpanel"]);
    const hits = res.hits.get("a.tsx");
    expect(hits).toBeDefined();
    expect(hits![0].snippet).toContain("RightPanel");
  });

  it("records exported const hits", () => {
    write("a.ts", "export const MY_WORK_PANEL = {};\n");
    const res = contentScan(tmp, ["a.ts"], ["work", "panel"]);
    const hits = res.hits.get("a.ts");
    expect(hits).toBeDefined();
  });

  it("skips files over 500KB", () => {
    const big = "x".repeat(600_000);
    write("big.ts", `const X = "${big}";\n// keyword\n`);
    const res = contentScan(tmp, ["big.ts"], ["keyword"]);
    expect(res.hits.get("big.ts")).toBeUndefined();
  });

  it("silently skips missing files", () => {
    const res = contentScan(tmp, ["does-not-exist.ts"], ["anything"]);
    expect(res.hits.size).toBe(0);
    expect(res.truncated).toBe(false);
  });

  it("caps hits per file at 3", () => {
    const body = Array(10).fill("keyword here").join("\n") + "\n";
    write("a.ts", body);
    const res = contentScan(tmp, ["a.ts"], ["keyword"]);
    expect(res.hits.get("a.ts")!.length).toBe(3);
  });

  it("returns durationMs and truncated on happy path", () => {
    write("a.ts", "keyword\n");
    const res = contentScan(tmp, ["a.ts"], ["keyword"]);
    expect(typeof res.durationMs).toBe("number");
    expect(res.truncated).toBe(false);
  });
});
