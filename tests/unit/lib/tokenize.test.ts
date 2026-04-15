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
  it("drops English and code stopwords", () => {
    const toks = tokenizeTask("card in my work panel");
    expect(toks).toContain("card");
    expect(toks).toContain("work");
    expect(toks).toContain("panel");
    expect(toks).not.toContain("in");
    expect(toks).not.toContain("my");
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
  it("includes expected English, task, and code noise", () => {
    expect(STOPWORDS.has("the")).toBe(true);
    expect(STOPWORDS.has("my")).toBe(true);
    expect(STOPWORDS.has("utils")).toBe(true);
  });
  it("does not include domain words", () => {
    expect(STOPWORDS.has("card")).toBe(false);
    expect(STOPWORDS.has("editor")).toBe(false);
  });
});
