import { describe, expect, it } from "vitest";
import { escapePromptData } from "./prompt-data.js";

describe("escapePromptData", () => {
  it("escapes only ampersands and angle brackets in one pass", () => {
    expect(escapePromptData('&<tag a="x">中🙂&lt;')).toBe('&amp;&lt;tag a="x"&gt;中🙂&amp;lt;');
    expect(escapePromptData("'")).toBe("'");
  });
  it("preserves empty and plain text", () => {
    expect(escapePromptData("")).toBe("");
    expect(escapePromptData("plain 中🙂")).toBe("plain 中🙂");
  });
});
