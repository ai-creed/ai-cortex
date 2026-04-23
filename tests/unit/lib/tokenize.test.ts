import { describe, expect, it } from "vitest";
import { tokenize, tokenizeTask, STOPWORDS } from "../../../src/lib/tokenize.js";

describe("tokenize (path/identifier mode — no stopword filter)", () => {
  it("splits camelCase and keeps joined form", () => {
    expect(tokenize("CardView")).toEqual(expect.arrayContaining(["card", "view", "cardview"]));
  });

  it("splits PascalCase with multiple segments", () => {
    const toks = tokenize("MyWorkPanel");
    expect(toks).toEqual(expect.arrayContaining(["my", "work", "panel", "myworkpanel"]));
  });

  it("handles ALLCAPS boundary without splitting chars", () => {
    const toks = tokenize("XMLParser");
    expect(toks).toEqual(expect.arrayContaining(["xml", "parser", "xmlparser"]));
    expect(toks).not.toContain("x");
    expect(toks).not.toContain("m");
  });

  it("splits snake_case", () => {
    const toks = tokenize("my_work_panel");
    expect(toks).toEqual(expect.arrayContaining(["my", "work", "panel", "myworkpanel"]));
  });

  it("tokenizes a full path with separators and extension", () => {
    const toks = tokenize("src/features/MyWork/Card.tsx");
    expect(toks).toEqual(expect.arrayContaining(["src", "features", "my", "work", "card", "tsx"]));
  });

  it("preserves digit groups", () => {
    const toks = tokenize("v2Api");
    expect(toks).toEqual(expect.arrayContaining(["v2", "api", "v2api"]));
  });

  it("drops single-char alpha tokens (but keeps digit-only)", () => {
    expect(tokenize("a.b.c")).toEqual([]);
    expect(tokenize("v9")).toEqual(expect.arrayContaining(["v9"]));
  });

  it("dedups", () => {
    const toks = tokenize("CardCard");
    expect(toks.filter((t) => t === "card")).toHaveLength(1);
    expect(toks).toContain("cardcard");
  });

  it("does NOT apply stopword filter (path mode keeps my, work, in, the)", () => {
    const toks = tokenize("src/my/work.ts");
    expect(toks).toContain("my");
    expect(toks).toContain("work");
  });
});

describe("tokenizeTask (task mode — stopword filter applied)", () => {
  it("drops English and code stopwords but keeps 'my' (domain-meaningful)", () => {
    const toks = tokenizeTask("card in my work panel");
    expect(toks).toContain("card");
    expect(toks).toContain("work");
    expect(toks).toContain("panel");
    expect(toks).not.toContain("in");
    // "my" is kept as domain-meaningful (e.g. a "My Work" feature name)
    expect(toks).toContain("my");
  });

  it("emits plural stems so 'sheets' matches paths containing 'sheet'", () => {
    const toks = tokenizeTask("sheets duplicate button");
    expect(toks).toContain("sheets");
    expect(toks).toContain("sheet");
  });

  it("stems '-ies' to '-y' (flies → fly)", () => {
    expect(tokenizeTask("flies")).toEqual(expect.arrayContaining(["flies", "fly"]));
  });

  it("stems '-xes/-ches/-shes/-sses/-zes' by trimming 'es'", () => {
    expect(tokenizeTask("boxes")).toEqual(expect.arrayContaining(["boxes", "box"]));
    expect(tokenizeTask("matches")).toEqual(expect.arrayContaining(["matches", "match"]));
    expect(tokenizeTask("hashes")).toEqual(expect.arrayContaining(["hashes", "hash"]));
  });

  it("does NOT stem words ending in 'ss', 'us', 'is', 'os', 'as'", () => {
    expect(tokenizeTask("address")).not.toContain("addres");
    expect(tokenizeTask("status")).not.toContain("statu");
    expect(tokenizeTask("this")).not.toContain("thi"); // also a stopword, extra safety
    expect(tokenizeTask("gas")).not.toContain("ga");
  });

  it("does not stem short words (len <= 3)", () => {
    expect(tokenize("as")).not.toContain("a");
  });

  it("still splits camelCase in task strings", () => {
    const toks = tokenizeTask("createCard");
    expect(toks).toEqual(expect.arrayContaining(["create", "card", "createcard"]));
  });

  it("returns empty for all-stopwords input", () => {
    expect(tokenizeTask("the of in a")).toEqual([]);
  });
});

describe("STOPWORDS", () => {
  it("includes expected English and code noise (but not 'my')", () => {
    expect(STOPWORDS.has("the")).toBe(true);
    expect(STOPWORDS.has("utils")).toBe(true);
    // "my" removed because it is load-bearing in domain names like "My Work"
    expect(STOPWORDS.has("my")).toBe(false);
  });
  it("does not include domain words", () => {
    expect(STOPWORDS.has("card")).toBe(false);
    expect(STOPWORDS.has("editor")).toBe(false);
  });
});
