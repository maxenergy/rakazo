import { describe, expect, it } from "vitest";
import { type OrgMember, renderOrgContext } from "./org-context.js";

const ceo: OrgMember = {
  id: "ceo-1",
  name: "CEO",
  orgRole: "ceo",
  team: "Launch team",
  reportsToBotId: null,
};
const cto: OrgMember = { ...ceo, id: "cto-1", name: "CTO", orgRole: "cto" };
const lead: OrgMember = {
  id: "lead-1",
  name: "Research lead",
  orgRole: "lead",
  team: "Research",
  reportsToBotId: "ceo-1",
};
const member: OrgMember = {
  id: "member-1",
  name: "Scout",
  orgRole: "member",
  team: "Research",
  reportsToBotId: "lead-1",
};
const org = [ceo, cto, lead, member];

describe("org context", () => {
  it("stays silent for a bot outside the org", () => {
    expect(renderOrgContext(null, org)).toBeUndefined();
  });

  it("gives the CEO and CTO decision authority and keeps a short list for the user", () => {
    for (const member of org) {
      const text = renderOrgContext(member, org) ?? "";
      expect(text).toContain("the CEO and CTO decide together, without the user");
      expect(text).toContain("Only these go to the user with submit_proposal");
      expect(text).toContain("a chat reply does not");
    }
  });

  it("tells a member who it reports to and where to escalate", () => {
    const text = renderOrgContext(member, org) ?? "";
    expect(text).toContain("you are the member on team Research");
    expect(text).toContain("You report to Research lead (lead, id lead-1).");
    expect(text).toContain("escalate it (kind technical) to the CTO, CTO (cto, id cto-1)");
    expect(text).toContain("escalate it (kind decision) to the CEO, CEO (ceo, id ceo-1)");
    expect(text).toContain("You cannot create bots");
  });

  it("lists the CEO's direct reports and has it record decisions with the CTO", () => {
    const text = renderOrgContext(ceo, org) ?? "";
    expect(text).toContain("You report to the user.");
    expect(text).toContain("Your direct reports: Research lead (lead, id lead-1), team Research.");
    expect(text).toContain("agree with the CTO and record it with record_decision");
    expect(text).not.toContain("to the CEO");
  });

  it("tells the CTO to review in full and hand the proposal back to the CEO", () => {
    const text = renderOrgContext(cto, org) ?? "";
    expect(text).toContain("write your full review in your reply");
    expect(text).toContain("hand it back to the CEO with handoff_to_bot");
  });

  it("does not tell the CTO to escalate to itself", () => {
    const text = renderOrgContext(cto, org) ?? "";
    expect(text).not.toContain("to the CTO,");
    expect(text).toContain("escalate it (kind decision) to the CEO");
  });
});
