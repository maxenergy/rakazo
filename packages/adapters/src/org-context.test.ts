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

  it("tells a member who it reports to and where to escalate", () => {
    const text = renderOrgContext(member, org) ?? "";
    expect(text).toContain("you are the member on team Research");
    expect(text).toContain("You report to Research lead (lead, id lead-1).");
    expect(text).toContain("escalate it (kind technical) to the CTO, CTO (cto, id cto-1)");
    expect(text).toContain("escalate it (kind decision) to the CEO, CEO (ceo, id ceo-1)");
    expect(text).toContain("You cannot create bots");
  });

  it("lists the CEO's direct reports and sends its decisions to the user", () => {
    const text = renderOrgContext(ceo, org) ?? "";
    expect(text).toContain("You report to the user.");
    expect(text).toContain("Your direct reports: Research lead (lead, id lead-1), team Research.");
    expect(text).toContain(
      "agree on a recommendation with the CTO, then send it to the user with submit_proposal",
    );
    expect(text).not.toContain("to the CEO");
  });

  it("does not tell the CTO to escalate to itself", () => {
    const text = renderOrgContext(cto, org) ?? "";
    expect(text).not.toContain("to the CTO,");
    expect(text).toContain("escalate it (kind decision) to the CEO");
  });
});
