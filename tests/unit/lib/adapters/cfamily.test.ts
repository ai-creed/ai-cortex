import { describe, expect, it, beforeAll } from "vitest";
import {
  createCAdapter,
  createCppAdapter,
} from "../../../../src/lib/adapters/cfamily.js";
import type { LangAdapter } from "../../../../src/lib/lang-adapter.js";

let cAdapter: LangAdapter;
let cppAdapter: LangAdapter;

beforeAll(async () => {
  cAdapter = await createCAdapter();
  cppAdapter = await createCppAdapter();
});

describe("cfamily adapter — boot", () => {
  it("c adapter reports the right extensions", () => {
    expect(cAdapter.extensions).toEqual([".c"]);
  });

  it("cpp adapter reports the right extensions", () => {
    expect(new Set(cppAdapter.extensions)).toEqual(
      new Set([".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h++", ".h"]),
    );
  });

  it("c adapter can parse an empty source without throwing", () => {
    const r = cAdapter.extractFile("", "x.c");
    expect(r).toEqual({ functions: [], rawCalls: [], importBindings: [] });
    expect(cAdapter.extractImportSites("", "x.c")).toEqual([]);
  });

  it("cpp adapter can parse an empty source without throwing", () => {
    const r = cppAdapter.extractFile("", "x.cpp");
    expect(r).toEqual({ functions: [], rawCalls: [], importBindings: [] });
    expect(cppAdapter.extractImportSites("", "x.cpp")).toEqual([]);
  });
});
