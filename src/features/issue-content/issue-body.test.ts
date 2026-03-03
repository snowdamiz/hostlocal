import hljs from "highlight.js/lib/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightIssueCode, parseIssueBody, parseIssueInlineTokens } from "./issue-body";

describe("parseIssueBody", () => {
  it("preserves language labels and code-block boundaries", () => {
    const blocks = parseIssueBody("Before\n\n```ts\nconst value = 1;\n```\n\nAfter");

    expect(blocks).toEqual([
      {
        kind: "paragraph",
        text: "Before",
      },
      {
        kind: "code",
        language: "ts",
        code: "const value = 1;",
      },
      {
        kind: "paragraph",
        text: "After",
      },
    ]);
  });
});

describe("parseIssueInlineTokens", () => {
  it("keeps surrounding plain text around inline code spans", () => {
    expect(parseIssueInlineTokens("Run `pnpm test` now.")).toEqual([
      {
        kind: "text",
        value: "Run ",
      },
      {
        kind: "inlineCode",
        value: "pnpm test",
      },
      {
        kind: "text",
        value: " now.",
      },
    ]);
  });

  it("treats unmatched backticks as plain text", () => {
    expect(parseIssueInlineTokens("Run `pnpm test now.")).toEqual([
      {
        kind: "text",
        value: "Run `pnpm test now.",
      },
    ]);
  });
});

describe("highlightIssueCode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("escapes html when language and auto-highlight paths fail", () => {
    vi.spyOn(hljs, "highlightAuto").mockImplementation(() => {
      throw new Error("highlight failure");
    });

    expect(highlightIssueCode("<script>alert('x')</script>", "unknown-language")).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
    );
  });
});
