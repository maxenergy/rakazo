import { UI_LOCALES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { localizeSubagentProgress } from "./subagent-progress.js";

describe("subagent progress localization", () => {
  it.each(UI_LOCALES)(
    "localizes runtime progress in %s and preserves tool identifiers",
    (locale) => {
      const starting = localizeSubagentProgress("starting…", locale);
      expect(starting).not.toBe("");
      if (locale !== "en") expect(starting).not.toBe("starting…");
      expect(localizeSubagentProgress("using browser_snapshot…", locale)).toContain(
        "browser_snapshot",
      );
      expect(localizeSubagentProgress("Looking through the project files.", locale)).toBe(
        "Looking through the project files.",
      );
    },
  );
});
