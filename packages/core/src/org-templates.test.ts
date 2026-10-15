import { describe, expect, it } from "vitest";
import { LAUNCH_TEAM_TEMPLATES, pickTemplateModel } from "./org-templates.js";

describe("launch team templates", () => {
  it("defines one CEO and one CTO", () => {
    expect(LAUNCH_TEAM_TEMPLATES.map((template) => template.orgRole)).toEqual(["ceo", "cto"]);
  });

  it("picks the first preferred model that is connected", () => {
    const template = {
      preferredModels: [
        { provider: "a", modelId: "best" },
        { provider: "b", modelId: "fallback" },
      ],
    };
    expect(
      pickTemplateModel(template, [
        { provider: "b", modelId: "fallback" },
        { provider: "a", modelId: "other" },
      ]),
    ).toEqual({ provider: "b", modelId: "fallback" });
    expect(pickTemplateModel(template, [])).toBeUndefined();
  });
});
