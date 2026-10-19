import { describe, expect, it } from "vitest";
import { escalationTarget } from "./org-context.js";
import { parseProposalArgs, proposalDecisionText } from "./proposal-tools.js";

describe("submit_proposal arguments", () => {
  it("trims, dedupes options, and requires kind, title, and summary", () => {
    expect(
      parseProposalArgs({
        kind: "decision",
        title: " Pick a stack ",
        summary: "Details",
        options: [" A ", "A", "", "B"],
      }),
    ).toEqual({
      ok: true,
      draft: {
        kind: "decision",
        title: "Pick a stack",
        summary: "Details",
        options: ["A", "B"],
        recommendation: "",
      },
    });
    expect(parseProposalArgs({ kind: "idea", title: "x", summary: "y" })).toMatchObject({
      ok: false,
    });
    expect(parseProposalArgs({ kind: "plan", title: "", summary: "y" })).toEqual({
      ok: false,
      error: "title is required.",
    });
    expect(
      parseProposalArgs({ kind: "plan", title: "x", summary: "y", options: "1234567".split("") }),
    ).toEqual({ ok: false, error: "Give at most 6 options." });
  });

  it("tells the bot whether to go ahead", () => {
    expect(
      proposalDecisionText({
        title: "Launch plan",
        status: "approved",
        chosenOption: "Fast",
        comment: "Watch cost",
      }),
    ).toBe("Approved: Launch plan\nChosen option: Fast\nComment: Watch cost\nGo ahead with it.");
    expect(
      proposalDecisionText({
        title: "Launch plan",
        status: "rejected",
        chosenOption: null,
        comment: null,
      }),
    ).toContain("Do not act on it.");
  });
});

describe("escalation routing", () => {
  const executives = { ceo: { id: "ceo-1", name: "CEO" }, cto: { id: "cto-1", name: "CTO" } };

  it("sends technical problems to the CTO and decisions to the CEO", () => {
    const member = { id: "m-1", orgRole: "member" as const };
    expect(escalationTarget("technical", member, executives)).toEqual({
      ok: true,
      target: executives.cto,
    });
    expect(escalationTarget("decision", member, executives)).toEqual({
      ok: true,
      target: executives.ceo,
    });
  });

  it("refuses escalations that would loop back or have nowhere to go", () => {
    expect(escalationTarget("decision", { id: "ceo-1", orgRole: "ceo" }, executives)).toMatchObject(
      { ok: false },
    );
    expect(
      escalationTarget("technical", { id: "cto-1", orgRole: "cto" }, executives),
    ).toMatchObject({ ok: false });
    expect(escalationTarget("technical", { id: "x", orgRole: null }, executives)).toMatchObject({
      ok: false,
    });
    expect(
      escalationTarget("technical", { id: "m-1", orgRole: "member" }, { ceo: null, cto: null }),
    ).toEqual({ ok: false, error: "This org has no CTO to escalate to." });
  });
});

it.each(["expired", "stale"] as const)("reports %s proposals accurately", (status) => {
  expect(
    proposalDecisionText({ title: "Budget request", status, chosenOption: null, comment: null }),
  ).toBe(`${status === "expired" ? "Expired" : "Stale"}: Budget request
Do not act on it. Revise it with the comment in mind, or ask me what to change.`);
});
