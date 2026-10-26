import { describe, expect, it } from "vitest";
import { orgRoleCanStaff, parseBotOrgRole } from "./org.js";

describe("bot org roles", () => {
  it("parses known roles and drops anything else", () => {
    expect(parseBotOrgRole("cto")).toBe("cto");
    expect(parseBotOrgRole("intern")).toBeNull();
    expect(parseBotOrgRole(null)).toBeNull();
  });

  it("lets leaders and bots outside the org staff, but not members", () => {
    expect(orgRoleCanStaff(null)).toBe(true);
    expect(orgRoleCanStaff("ceo")).toBe(true);
    expect(orgRoleCanStaff("cto")).toBe(true);
    expect(orgRoleCanStaff("lead")).toBe(true);
    expect(orgRoleCanStaff("member")).toBe(false);
  });
});
