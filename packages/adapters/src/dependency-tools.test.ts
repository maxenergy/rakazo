import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketToolDeps } from "./ticket-tools.js";

const db = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn(), read: vi.fn() }));
vi.mock("@rakazo/db", () => {
  class ProjectLinkError extends Error {}
  return {
    addTicketDependency: db.add,
    removeTicketDependency: db.remove,
    readTicketDependencies: db.read,
    Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
    ProjectLinkError,
    withTransactionRetry: (work: () => unknown) => work(),
  };
});

import { ProjectLinkError } from "@rakazo/db";
import { executeDependencyTool } from "./dependency-tools.js";

function setup() {
  const tx = {
    ticket: {
      findFirstOrThrow: vi
        .fn()
        .mockResolvedValue({ id: "ticket", boardId: "board", assigneeBotId: null }),
    },
  };
  const transaction = vi.fn(async (work: (value: typeof tx) => unknown) => work(tx));
  const notify = vi.fn();
  const deps = {
    prisma: { $transaction: transaction },
    ticketBoardEnabled: true,
    onTicketChange: notify,
  } as unknown as TicketToolDeps;
  return { deps, tx, transaction, notify };
}

describe("dependency tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.add.mockReset();
    db.remove.mockReset();
    db.read.mockReset();
    db.read.mockResolvedValue({ prerequisites: [], dependents: [], blockedByDependency: false });
  });

  it("rejects calls while the board is disabled", async () => {
    const s = setup();
    s.deps.ticketBoardEnabled = false;
    expect(
      await executeDependencyTool(s.deps, "space", "ticket_dependency_list", {
        ticketId: "ticket",
      }),
    ).toEqual({ error: "Ticket board is disabled." });
    expect(s.transaction).not.toHaveBeenCalled();
  });

  it.each([{}, { ticketId: 3 }, { ticketId: "" }, { ticketId: "ticket", extraId: "other" }])(
    "rejects invalid list arguments %j",
    async (args) => {
      const s = setup();
      expect(await executeDependencyTool(s.deps, "space", "ticket_dependency_list", args)).toEqual({
        error: expect.any(String),
      });
      expect(s.transaction).not.toHaveBeenCalled();
    },
  );

  it.each(["ticket_dependency_add", "ticket_dependency_remove"] as const)(
    "validates and executes %s",
    async (name) => {
      const s = setup();
      for (const args of [
        { ticketId: "ticket" },
        { ticketId: "ticket", prerequisiteId: 1 },
        { ticketId: "ticket", prerequisiteId: "prior", extraId: "other" },
      ]) {
        expect(await executeDependencyTool(s.deps, "space", name, args)).toEqual({
          error: expect.any(String),
        });
      }
      expect(s.transaction).not.toHaveBeenCalled();
      expect(
        await executeDependencyTool(s.deps, "space", name, {
          ticketId: "ticket",
          prerequisiteId: "prior",
        }),
      ).toEqual({ prerequisites: [], dependents: [], blockedByDependency: false });
      expect(name === "ticket_dependency_add" ? db.add : db.remove).toHaveBeenCalledWith(
        s.tx,
        "space",
        "ticket",
        "prior",
      );
      expect(s.notify).toHaveBeenCalledWith({
        spaceId: "space",
        boardId: "board",
        ticketId: "ticket",
        assigneeBotId: null,
        wakeAssignee: false,
      });
    },
  );

  it("reads in the caller space without mutation notifications", async () => {
    const s = setup();
    await executeDependencyTool(s.deps, "space", "ticket_dependency_list", { ticketId: "ticket" });
    expect(db.read).toHaveBeenCalledWith(s.tx, "space", "ticket");
    expect(db.add).not.toHaveBeenCalled();
    expect(db.remove).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("returns domain errors without emitting a change", async () => {
    const s = setup();
    db.add.mockRejectedValue(
      new ProjectLinkError("BAD_REQUEST", "A ticket cannot depend on itself."),
    );
    expect(
      await executeDependencyTool(s.deps, "space", "ticket_dependency_add", {
        ticketId: "ticket",
        prerequisiteId: "ticket",
      }),
    ).toEqual({ error: expect.any(String) });
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("propagates unexpected transaction failures", async () => {
    const s = setup();
    db.read.mockRejectedValue(new Error("database unavailable"));
    await expect(
      executeDependencyTool(s.deps, "space", "ticket_dependency_list", { ticketId: "ticket" }),
    ).rejects.toThrow("database unavailable");
    expect(s.notify).not.toHaveBeenCalled();
  });
});
