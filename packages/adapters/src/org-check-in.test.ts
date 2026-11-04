import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORG_CHECK_IN_DAILY_LIMIT,
  ORG_CHECK_IN_IDLE_MS,
  ORG_CHECK_IN_REPEAT_MS,
  ORG_RECORD_ONLY_DAILY_LIMIT,
  ORG_RECORD_ONLY_REPEAT_MS,
  orgCheckInPrompt,
  orgNeedsCheckIn,
  orgRecordOnlyDue,
  reconcileOrgCheckIns,
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

describe("tickets whose owner's run failed", () => {
  const busy = { now, activeRuns: 2, checkInsToday: 0, lastRun: idle(), ceoActive: false };
  const failedTickets = ["RAK-70 (owner Backend)"];

  it("wakes the CEO soon after a failure, even while others work", () => {
    const lastCheckInAt = new Date(now.getTime() - ORG_CHECK_IN_IDLE_MS);
    expect(orgNeedsCheckIn({ ...busy, failedTickets, lastCheckInAt })).toBe(true);
  });

  it("waits while the CEO works, right after a check-in, and at the daily limit", () => {
    const recent = new Date(now.getTime() - 60_000);
    expect(orgNeedsCheckIn({ ...busy, failedTickets, ceoActive: true })).toBe(false);
    expect(orgNeedsCheckIn({ ...busy, failedTickets, lastCheckInAt: recent })).toBe(false);
    expect(
      orgNeedsCheckIn({ ...busy, failedTickets, checkInsToday: ORG_CHECK_IN_DAILY_LIMIT }),
    ).toBe(false);
  });

  it("names the tickets in the prompt", () => {
    expect(orgCheckInPrompt(0, [], [], failedTickets)).toContain("RAK-70 (owner Backend)");
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

describe("record-only organization reconciliation", () => {
  afterEach(() => vi.unstubAllEnvs());

  function fixture({ realDue = false, count = 0, lastAt = null as Date | null } = {}) {
    const runCreate = vi.fn(async () => ({ id: "record-run" }));
    const ticketQueries: unknown[] = [];
    const runQueries: unknown[] = [];
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          { id: "ceo", spaceId: "space", userId: "user", thread: { id: "thread" } },
        ]),
      },
      run: {
        count: vi.fn(async ({ where }: { where: { trigger?: unknown } }) => {
          runQueries.push(where);
          return where.trigger === "org_check_in_record_only" ? count : 0;
        }),
        findFirst: vi.fn(async ({ where }: { where: { trigger?: unknown } }) => {
          runQueries.push(where);
          if (where.trigger === "org_check_in_record_only")
            return lastAt ? { createdAt: lastAt } : null;
          if (where.trigger === "org_check_in")
            return { createdAt: new Date(now.getTime() - 120 * 60_000) };
          return {
            trigger: "user",
            updatedAt: new Date(now.getTime() - (realDue ? 20 : 1) * 60_000),
          };
        }),
      },
      ticket: {
        findMany: vi.fn(async (query: unknown) => {
          ticketQueries.push(query);
          return [];
        }),
      },
      proposal: { count: vi.fn(async () => 0) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          task: { create: vi.fn(async () => ({ id: "task" })) },
          run: { create: runCreate },
        }),
      ),
    };
    const enqueue = vi.fn(async () => undefined);
    return {
      prisma,
      runCreate,
      enqueue,
      ticketQueries,
      runQueries,
      reconcile: () =>
        reconcileOrgCheckIns(
          {
            prisma: prisma as unknown as PrismaClient,
            jobs: {
              enqueue,
              cancel: vi.fn(async () => undefined),
              close: vi.fn(async () => undefined),
            },
          },
          now,
        ),
    };
  }

  it("keeps empty configuration unchanged", async () => {
    vi.stubEnv("RECORD_ONLY_ORG_CHECK_IN_BOT_IDS", "");
    const f = fixture();
    await f.reconcile();
    expect(f.runCreate).not.toHaveBeenCalled();
  });

  it("gives real work priority and never spends the record-only quota", async () => {
    vi.stubEnv("RECORD_ONLY_ORG_CHECK_IN_BOT_IDS", "ceo");
    const f = fixture({ realDue: true });
    await f.reconcile();
    expect(f.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "org_check_in" }) }),
    );
    expect(f.runQueries).not.toContainEqual(
      expect.objectContaining({ trigger: "org_check_in_record_only" }),
    );
  });

  it("isolates activity and real failure watermark from record-only success or failure", async () => {
    vi.stubEnv("RECORD_ONLY_ORG_CHECK_IN_BOT_IDS", " other, ceo ");
    const f = fixture();
    await f.reconcile();
    expect(f.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "org_check_in_record_only" }),
      }),
    );
    expect(
      f.runQueries.filter((q) => JSON.stringify(q).includes('"not":"org_check_in_record_only"')),
    ).toHaveLength(3);
    expect(f.runQueries).toContainEqual(expect.objectContaining({ trigger: "org_check_in" }));
    expect(f.ticketQueries[0]).toMatchObject({
      where: { assigneeBot: { runs: { none: { trigger: { not: "org_check_in_record_only" } } } } },
    });
    expect(f.ticketQueries[1]).toMatchObject({
      where: {
        assigneeBot: {
          id: { not: "ceo" },
          runs: { some: { updatedAt: { gt: new Date(now.getTime() - 120 * 60_000) } } },
        },
      },
    });
  });

  it.each([{ count: 6 }, { lastAt: now }])(
    "throttles its own attempts regardless of outcome: %j",
    async (options) => {
      vi.stubEnv("RECORD_ONLY_ORG_CHECK_IN_BOT_IDS", "ceo");
      const f = fixture(options);
      await f.reconcile();
      expect(f.runCreate).not.toHaveBeenCalled();
    },
  );

  it("uses a six-per-rolling-day cap and one-hour creation throttle", () => {
    expect(orgRecordOnlyDue(ORG_RECORD_ONLY_DAILY_LIMIT, null, now)).toBe(false);
    expect(orgRecordOnlyDue(0, new Date(now.getTime() - ORG_RECORD_ONLY_REPEAT_MS + 1), now)).toBe(
      false,
    );
    expect(orgRecordOnlyDue(5, new Date(now.getTime() - ORG_RECORD_ONLY_REPEAT_MS), now)).toBe(
      true,
    );
  });
});
