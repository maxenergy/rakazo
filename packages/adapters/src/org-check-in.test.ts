import { describe, expect, it } from "vitest";
import {
  ORG_CHECK_IN_DAILY_LIMIT,
  ORG_CHECK_IN_IDLE_MS,
  ORG_CHECK_IN_REPEAT_MS,
  orgCheckInPrompt,
  orgNeedsCheckIn,
} from "./org-check-in.js";

const now = new Date("2026-10-16T10:30:00Z");
const idle = (trigger = "bot_message") => ({
  trigger,
  updatedAt: new Date(now.getTime() - ORG_CHECK_IN_IDLE_MS),
});
const quiet = { now, activeRuns: 0, checkInsToday: 0, lastRun: idle() };

describe("orgNeedsCheckIn", () => {
  it("wakes the CEO once the whole org has been idle long enough", () => {
    expect(orgNeedsCheckIn(quiet)).toBe(true);
  });

  it("waits while any org bot still has a run", () => {
    expect(orgNeedsCheckIn({ ...quiet, activeRuns: 1 })).toBe(false);
  });

  it("waits until the org has been idle for the full window", () => {
    const recent = { trigger: "bot_message", updatedAt: new Date(now.getTime() - 60_000) };
    expect(orgNeedsCheckIn({ ...quiet, lastRun: recent })).toBe(false);
  });

  it("waits longer after a check-in that found nothing to start", () => {
    expect(orgNeedsCheckIn({ ...quiet, lastRun: idle("org_check_in") })).toBe(false);
    const hourAgo = {
      trigger: "org_check_in",
      updatedAt: new Date(now.getTime() - ORG_CHECK_IN_REPEAT_MS),
    };
    expect(orgNeedsCheckIn({ ...quiet, lastRun: hourAgo })).toBe(true);
  });

  it("asks the CEO about members idle while the rest of the org works", () => {
    const busy = { ...quiet, activeRuns: 2, ceoActive: false, lastCheckInAt: null };
    expect(orgNeedsCheckIn({ ...busy, idleMembers: ["Code Reviewer"] })).toBe(true);
    expect(orgNeedsCheckIn({ ...busy, idleMembers: [] })).toBe(false);
    expect(orgNeedsCheckIn({ ...busy, idleMembers: ["Code Reviewer"], ceoActive: true })).toBe(
      false,
    );
    const recent = new Date(now.getTime() - 10 * 60_000);
    expect(
      orgNeedsCheckIn({ ...busy, idleMembers: ["Code Reviewer"], lastCheckInAt: recent }),
    ).toBe(false);
    expect(orgCheckInPrompt(0, ["Code Reviewer"])).toContain("Code Reviewer");
  });

  it("skips an org that never ran and stops at the daily limit", () => {
    expect(orgNeedsCheckIn({ ...quiet, lastRun: null })).toBe(false);
    expect(orgNeedsCheckIn({ ...quiet, checkInsToday: ORG_CHECK_IN_DAILY_LIMIT })).toBe(false);
  });
});

describe("orgCheckInPrompt", () => {
  it("says the check-in is automatic and how long the org was idle", () => {
    const prompt = orgCheckInPrompt(12);
    expect(prompt).toContain("not from the user");
    expect(prompt).toContain("12 minutes");
    expect(prompt).toContain("message_bot");
  });
});

describe("ready tickets left unstarted", () => {
  const busy = { now, activeRuns: 2, checkInsToday: 0, lastRun: idle(), ceoActive: false };

  it("wakes the CEO while others work when a ready ticket sits unstarted", () => {
    expect(orgNeedsCheckIn({ ...busy, readyTickets: ["RAK-65 (blocked, owner Delivery)"] })).toBe(
      true,
    );
    expect(orgNeedsCheckIn(busy)).toBe(false);
  });

  it("does not repeat within the check-in interval or while the CEO works", () => {
    const recent = new Date(now.getTime() - 60_000);
    expect(orgNeedsCheckIn({ ...busy, readyTickets: ["RAK-65"], lastCheckInAt: recent })).toBe(
      false,
    );
    expect(orgNeedsCheckIn({ ...busy, readyTickets: ["RAK-65"], ceoActive: true })).toBe(false);
  });

  it("names the ready tickets in the prompt", () => {
    expect(orgCheckInPrompt(0, [], ["RAK-65 (blocked, owner Delivery)"])).toContain(
      "RAK-65 (blocked, owner Delivery)",
    );
  });
});

describe("finished work and pending proposals", () => {
  it("does not wake an idle org that waits on an undecided proposal", () => {
    expect(orgNeedsCheckIn({ ...quiet, pendingProposals: 1 })).toBe(false);
    expect(orgNeedsCheckIn({ ...quiet, pendingProposals: 0 })).toBe(true);
  });

  it("asks the CEO to propose the next phase once the agreed work is done", () => {
    expect(orgCheckInPrompt(30)).toContain("submit_proposal");
  });
});
