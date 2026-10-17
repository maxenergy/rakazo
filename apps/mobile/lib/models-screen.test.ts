import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelCatalogEntry } from "@rakazo/contracts";
import { catalogMetadataLines, sortModelCatalogByCost } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { resetI18nForTests, t } from "./i18n";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screen = readFileSync(resolve(mobileRoot, "app/(settings)/models.tsx"), "utf8");

function sliceBetween(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("Models settings form", () => {
  it("aligns editable limit fields and displays shared catalog metadata", () => {
    const field = sliceBetween(screen, "function limitField(", "const compatConfig");
    expect(field).toContain("styles.sectionTitle");
    expect(field).toContain("style={styles.keyInput}");
    expect(field).not.toContain("modelRow");
    expect(field).not.toContain("maxImagesInput");
    expect(screen).toContain('limitField(t("Maximum output tokens")');
    expect(screen).toContain('limitField(t("Context limit")');
    expect(screen).toMatch(/limitField\(\s*t\("Maximum images per request"\)/);
    expect(screen).not.toContain("selected.billing");
    expect(screen).not.toContain('t("Stored securely. Never shown here.")');
    expect(screen).not.toContain('t("Connect this provider to use it as your personal model.")');
  });

  it("uses a disclosure row for Advanced instead of an underlined link", () => {
    const row = sliceBetween(screen, "function disclosureRow(", "function limitField(");
    expect(row).toContain("styles.card");
    expect(row).toContain("styles.modelRow");
    expect(row).toContain("styles.chevron");
    expect(row).not.toContain("textDecorationLine");
    expect(row).not.toContain("helpLabel");
    expect(screen).toContain('disclosureRow(t("Advanced")');
    expect(screen).not.toContain("helpLabel");
  });

  it("exposes the shown thinking value on the effort rows", () => {
    const effort = sliceBetween(
      screen,
      'accessibilityLabel={t("Reasoning effort")}',
      't("Supports images")',
    );
    expect(effort).toContain("accessibilityValue={{ text: reasoningEffortValue }}");
    expect(effort).toContain("{reasoningEffortValue}");
    const thinking = sliceBetween(
      screen,
      'accessibilityLabel={t("Thinking")}',
      'disclosureRow(t("Advanced")',
    );
    expect(thinking).toContain("accessibilityValue={{ text: catalogThinkingValue }}");
    expect(thinking).toContain("{catalogThinkingValue}");
  });
});

it.each([undefined, false, true])(
  "mobile catalog copy preserves unknown limits and reasoning=%s",
  (reasoning) => {
    resetI18nForTests("en");
    const entry: ModelCatalogEntry = {
      provider: "example",
      id: "example",
      label: "Example",
      billing: "API key",
      auth: "api-key",
      contextWindow: null,
      maxTokens: null,
      reasoning,
    };
    expect(screen).toMatch(/catalogMetadataLines\(\s*selected,/);
    const lines = catalogMetadataLines(entry, undefined, t);
    expect(lines).toContain("Context window: Unknown");
    expect(lines).toContain("Maximum output tokens: Unknown");
    expect(lines.includes("Does not support reasoning")).toBe(reasoning === false);
    expect(lines.includes("Supports reasoning")).toBe(reasoning === true);
    expect(lines.join(" ")).not.toContain("$0");
  },
);

it("connects optional cost sorting after mobile model filtering", () => {
  expect(screen).toContain("const [sortByCost, setSortByCost] = useState(false)");
  expect(screen).toContain("sortModelCatalogByCost(matchedModels,");
  expect(screen).toContain("onValueChange={setSortByCost}");
  const model = (id: string, price: number): ModelCatalogEntry => ({
    provider: "example",
    id,
    label: id,
    billing: "API key",
    auth: "api-key",
    billingModes: ["api-key"],
    pricing: {
      inputPerMTok: price,
      outputPerMTok: 1,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
  });
  const matched = [model("expensive", 5), model("cheap", 1)];
  expect(sortModelCatalogByCost(matched).map(({ id }) => id)).toEqual(["cheap", "expensive"]);
  expect(matched.map(({ id }) => id)).toEqual(["expensive", "cheap"]);
});
