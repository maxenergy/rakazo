import { describe, expect, it } from "vitest";
import { modelBillingCopy } from "./model-catalog-copy.js";

describe("model catalog copy", () => {
  it("separates provider names from the product's API billing template", () => {
    expect(
      modelBillingCopy("Uses your Example AI API key. Rakazo does not pay for model usage."),
    ).toEqual({ kind: "api", name: "Example AI" });
  });

  it("recognizes subscription and local billing templates", () => {
    expect(
      modelBillingCopy(
        "Sign in with ChatGPT Plus or Pro. Uses your OpenAI subscription. Rakazo does not pay.",
      ),
    ).toEqual({ kind: "subscription", name: "ChatGPT Plus / Pro" });
    expect(
      modelBillingCopy(
        "Sign in with SuperGrok or X Premium, or paste an xAI API key. Rakazo does not pay.",
      ),
    ).toEqual({ kind: "grok" });
    expect(
      modelBillingCopy("Runs on a URL you control. Rakazo does not pay for model usage."),
    ).toEqual({ kind: "custom" });
  });

  it("preserves third-party catalog text as supplied", () => {
    expect(modelBillingCopy("Example plan includes 100 requests.")).toEqual({
      kind: "literal",
      text: "Example plan includes 100 requests.",
    });
  });
});
