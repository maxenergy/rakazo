import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: true,
};
const date = new Date("2026-01-01T00:00:00.000Z");
const rows = ["c", "b", "a"].map((id, index) => ({
  id,
  boardId: "board-1",
  spaceId: actor.spaceId,
  projectId: null,
  milestoneId: null,
  number: index + 1,
  title: id,
  description: "",
  status: "todo",
  priority: "normal",
  assigneeBotId: null,
  createdByBotId: null,
  createdByUserId: null,
  createdAt: date,
  updatedAt: id === "a" ? new Date("2025-12-31T00:00:00.000Z") : date,
  completedAt: null,
}));
function setup() {
  const findMany = vi.fn(async (args) => {
    const boundary = args.where.AND?.[0].OR;
    const filtered = rows.filter(
      (row) =>
        !boundary ||
        row.updatedAt < boundary[0].updatedAt.lt ||
        (row.updatedAt.getTime() === boundary[1].updatedAt.getTime() && row.id < boundary[1].id.lt),
    );
    return filtered.slice(0, args.take);
  });
  const prisma = {
    board: { findUnique: vi.fn(async () => ({ id: "board-1", ticketPrefix: "TEST" })) },
    ticket: { findMany },
    $transaction: vi.fn(async (fn) => fn(prisma)),
  };
  const client = createRouterClient(
    createRouter({
      prisma,
      env: { ticketBoardEnabled: true },
    } as unknown as RouterDeps),
    { context: { actor } },
  );
  return { client, findMany };
}
describe("ticket pagination", () => {
  it("preserves the complete legacy response and ordering without a limit", async () => {
    const { client, findMany } = setup();
    const result = await client.tickets.list({});
    expect(Object.keys(result)).toEqual(["tickets"]);
    expect("tickets" in result && result.tickets.map((row) => row.id)).toEqual(["c", "b", "a"]);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty("take");
  });
  it("pages equal timestamps by descending id and ends with a null cursor", async () => {
    const { client, findMany } = setup();
    const first = await client.tickets.list({ limit: 2 });
    expect("items" in first && first.items.map((row) => row.id)).toEqual(["c", "b"]);
    if (!("nextCursor" in first) || !first.nextCursor) throw new Error("Missing cursor");
    const second = await client.tickets.list({ limit: 2, cursor: first.nextCursor });
    expect(second).toMatchObject({ items: [{ id: "a" }], nextCursor: null });
    expect(findMany.mock.calls[1]?.[0].where.AND).toEqual([
      { OR: [{ updatedAt: { lt: date } }, { updatedAt: date, id: { lt: "b" } }] },
    ]);
  });
  it("rejects malformed cursors", async () => {
    const { client } = setup();
    await expect(client.tickets.list({ limit: 2, cursor: "invalid" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
  it("maps isolation failures at the RPC boundary to a retryable conflict", async () => {
    const { client, findMany } = setup();
    findMany.mockRejectedValueOnce(new IsolationError());
    await expect(client.tickets.list({})).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  });
});
