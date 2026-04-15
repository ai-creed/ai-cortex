import { describe, expect, it } from "vitest";
import {
  trigrams,
  buildTrigramIndex,
  trigramQuery,
  trigramSim,
} from "../../../src/lib/trigram-index.js";

describe("trigrams", () => {
  it("produces 3-char sliding windows", () => {
    expect(trigrams("editor")).toEqual(new Set(["edi", "dit", "ito", "tor"]));
  });

  it("returns empty for strings shorter than 3", () => {
    expect(trigrams("ab")).toEqual(new Set());
  });

  it("lowercases input", () => {
    expect(trigrams("EDIT")).toEqual(new Set(["edi", "dit"]));
  });
});

describe("trigramSim (Jaccard similarity)", () => {
  it("returns 1 for identical strings", () => {
    expect(trigramSim("editor", "editor")).toBeCloseTo(1);
  });

  it("reflects related morphology in Jaccard sim (editing vs editor)", () => {
    // editing {edi,dit,iti,tin,ing}(5) vs editor {edi,dit,ito,tor}(4)
    // shared={edi,dit}(2), union=7, Jaccard = 2/7 ≈ 0.286. This is below the
    // default minOverlap (0.4) so this pair would NOT be matched by
    // trigramQuery — that's OK; the test just documents the actual value.
    expect(trigramSim("editing", "editor")).toBeCloseTo(2 / 7, 3);
  });

  it("reaches the default threshold for card vs carding", () => {
    // card {car,ard}(2) vs carding {car,ard,rdi,din,ing}(5)
    // shared=2, union=5, Jaccard = 0.4 exactly — matches default minOverlap.
    expect(trigramSim("card", "carding")).toBeCloseTo(0.4);
  });

  it("scores substring morphology above threshold (edit vs editor)", () => {
    // edit {edi,dit}(2) vs editor {edi,dit,ito,tor}(4)
    // shared=2, union=4, Jaccard = 0.5.
    expect(trigramSim("edit", "editor")).toBeGreaterThanOrEqual(0.4);
  });

  it("returns 0 for fully disjoint strings", () => {
    expect(trigramSim("foo", "bar")).toBe(0);
  });

  it("handles non-ASCII without crashing", () => {
    expect(() => trigramSim("café", "latte")).not.toThrow();
  });
});

describe("buildTrigramIndex + trigramQuery (per-token)", () => {
  it("finds an item whose token set contains one fuzzy-similar to the query", () => {
    const idx = buildTrigramIndex([
      {
        id: "a.ts",
        tokens: [
          "src",
          "features",
          "mywork",
          "card",
          "title",
          "editor",
          "createcard",
          "handletitleedit",
        ],
      },
      { id: "b.ts", tokens: ["unrelated", "helper", "noise"] },
    ]);
    const hits = trigramQuery(idx, "editor");
    expect(hits.get("a.ts")?.sim).toBeGreaterThanOrEqual(0.9);
    expect(hits.get("a.ts")?.matchedToken).toBe("editor");
    expect(hits.get("b.ts")).toBeUndefined();
  });

  it("reports the actual file-side token that produced the max sim", () => {
    const idx = buildTrigramIndex([
      { id: "a.ts", tokens: ["unrelated", "carding", "noise"] },
    ]);
    const hits = trigramQuery(idx, "card");
    // "card" vs "carding" is Jaccard 0.4, vs the others ~0.
    expect(hits.get("a.ts")?.matchedToken).toBe("carding");
  });

  it("returns the MAX similarity over the item's tokens (not an average)", () => {
    const idx = buildTrigramIndex([
      {
        id: "a.ts",
        tokens: ["editor", "zzz1", "zzz2", "zzz3", "zzz4", "zzz5"],
      },
    ]);
    const hits = trigramQuery(idx, "editor");
    expect(hits.get("a.ts")?.sim).toBeCloseTo(1);
    expect(hits.get("a.ts")?.matchedToken).toBe("editor");
  });

  it("respects minOverlap threshold", () => {
    const idx = buildTrigramIndex([{ id: "a.ts", tokens: ["xxxyyy"] }]);
    const hits = trigramQuery(idx, "abc", 0.4);
    expect(hits.get("a.ts")).toBeUndefined();
  });

  it("ignores tokens shorter than 3 chars on both sides", () => {
    const idx = buildTrigramIndex([{ id: "a.ts", tokens: ["ab", "editor"] }]);
    const hits = trigramQuery(idx, "editor");
    expect(hits.get("a.ts")?.sim).toBeGreaterThan(0);
    expect(hits.get("a.ts")?.matchedToken).toBe("editor");
  });

  it("empty input does not crash", () => {
    const idx = buildTrigramIndex([]);
    expect(() => trigramQuery(idx, "anything")).not.toThrow();
    expect(trigramQuery(idx, "anything").size).toBe(0);
  });
});
