import { describe, expect, it } from "vitest";
import { BotSchema, SpaceBotSchema } from "./domain.js";

describe("work location contracts", () => {
  it("preserves host location in space rosters and defaults older payloads", () => {
    expect(SpaceBotSchema.shape.workLocation.parse("host")).toBe("host");
    expect(SpaceBotSchema.shape.workLocation.parse(undefined)).toBe("container");
  });
  it("exposes the granting user and defaults older payloads", () => {
    expect(BotSchema.shape.hostGrantedByUserId.parse("owner")).toBe("owner");
    expect(BotSchema.shape.hostGrantedByUserId.parse(undefined)).toBeNull();
  });
});
