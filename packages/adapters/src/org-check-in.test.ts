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
