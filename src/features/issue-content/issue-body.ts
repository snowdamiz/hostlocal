import hljs from "highlight.js/lib/core";
import bashLanguage from "highlight.js/lib/languages/bash";
import javascriptLanguage from "highlight.js/lib/languages/javascript";
import jsonLanguage from "highlight.js/lib/languages/json";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import plaintextLanguage from "highlight.js/lib/languages/plaintext";
import rustLanguage from "highlight.js/lib/languages/rust";
import shellLanguage from "highlight.js/lib/languages/shell";
import typescriptLanguage from "highlight.js/lib/languages/typescript";
import xmlLanguage from "highlight.js/lib/languages/xml";
import yamlLanguage from "highlight.js/lib/languages/yaml";

export type IssueBodyBlock =
  | {
      kind: "paragraph";
      text: string;
    }
  | {
      kind: "code";
      language: string | null;
      code: string;
    };

export type IssueBodyInlineToken =
  | {
      kind: "text";
      value: string;
    }
  | {
      kind: "inlineCode";
      value: string;
    };

let hasRegisteredHighlightLanguages = false;

const ensureHighlightLanguagesRegistered = () => {
  if (hasRegisteredHighlightLanguages) {
    return;
  }

  hljs.registerLanguage("plaintext", plaintextLanguage);
  hljs.registerLanguage("bash", bashLanguage);
  hljs.registerLanguage("shell", shellLanguage);
  hljs.registerLanguage("javascript", javascriptLanguage);
  hljs.registerLanguage("typescript", typescriptLanguage);
  hljs.registerLanguage("json", jsonLanguage);
  hljs.registerLanguage("yaml", yamlLanguage);
  hljs.registerLanguage("rust", rustLanguage);
  hljs.registerLanguage("markdown", markdownLanguage);
  hljs.registerLanguage("xml", xmlLanguage);

  hasRegisteredHighlightLanguages = true;
};

export const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const parseIssueBody = (input: string): IssueBodyBlock[] => {
  const normalizedInput = input.replaceAll(/\r\n?/g, "\n");
  const blocks: IssueBodyBlock[] = [];
  const paragraphLines: string[] = [];
  let codeLines: string[] = [];
  let isInCodeBlock = false;
  let activeCodeLanguage: string | null = null;

  const flushParagraph = () => {
    const paragraphText = paragraphLines.join("\n").trim();
    paragraphLines.length = 0;
    if (paragraphText.length > 0) {
      blocks.push({
        kind: "paragraph",
        text: paragraphText,
      });
    }
  };

  const flushCodeBlock = () => {
    blocks.push({
      kind: "code",
      language: activeCodeLanguage,
      code: codeLines.join("\n"),
    });
    codeLines = [];
    activeCodeLanguage = null;
  };

  for (const line of normalizedInput.split("\n")) {
    const fenceMatch = line.match(/^```([\w#+.-]*)\s*$/);
    if (fenceMatch) {
      if (isInCodeBlock) {
        flushCodeBlock();
        isInCodeBlock = false;
      } else {
        flushParagraph();
        isInCodeBlock = true;
        activeCodeLanguage = fenceMatch[1] ? fenceMatch[1] : null;
      }
      continue;
    }

    if (isInCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    paragraphLines.push(line);
  }

  if (isInCodeBlock) {
    flushCodeBlock();
  } else {
    flushParagraph();
  }

  return blocks;
};

export const parseIssueInlineTokens = (text: string): IssueBodyInlineToken[] => {
  const tokens: IssueBodyInlineToken[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const inlineCodeStart = text.indexOf("`", cursor);
    if (inlineCodeStart < 0) {
      tokens.push({
        kind: "text",
        value: text.slice(cursor),
      });
      break;
    }

    const inlineCodeEnd = text.indexOf("`", inlineCodeStart + 1);
    if (inlineCodeEnd < 0) {
      tokens.push({
        kind: "text",
        value: text.slice(cursor),
      });
      break;
    }

    if (inlineCodeStart > cursor) {
      tokens.push({
        kind: "text",
        value: text.slice(cursor, inlineCodeStart),
      });
    }

    const inlineCodeValue = text.slice(inlineCodeStart + 1, inlineCodeEnd);
    if (inlineCodeValue.length === 0) {
      tokens.push({
        kind: "text",
        value: "``",
      });
    } else {
      tokens.push({
        kind: "inlineCode",
        value: inlineCodeValue,
      });
    }

    cursor = inlineCodeEnd + 1;
  }

  return tokens.length > 0
    ? tokens
    : [
        {
          kind: "text",
          value: text,
        },
      ];
};

export const highlightIssueCode = (code: string, language: string | null) => {
  ensureHighlightLanguagesRegistered();

  const normalizedLanguage = language?.trim().toLowerCase() ?? "";
  if (normalizedLanguage.length > 0 && hljs.getLanguage(normalizedLanguage)) {
    try {
      return hljs.highlight(code, {
        language: normalizedLanguage,
        ignoreIllegals: true,
      }).value;
    } catch {
      // Ignore and continue with fallback highlighting.
    }
  }

  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
};
