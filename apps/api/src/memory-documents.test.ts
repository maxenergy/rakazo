import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  exportMemoryMarkdown,
  listMemoryDocuments,
  readMemoryDocument,
} from "./memory-documents.js";

const actor = { spaceId: "space-a", userId: "user-a" } as Actor;
const docs = ["c", "a", "b"].map((id) => ({
  id,
  spaceId: "space-a",
  userId: "user-a",
  scope: "bot",
  botId: "bot-a",
  path: `${id}.md`,
  content: `body-${id}`,
  revision: 1,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
}));
function fixture() {
  const rows = [...docs, { ...docs[0]!, id: "foreign", spaceId: "other" }];
  const matches = (row: (typeof rows)[number], filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, value]) =>
      key === "id" && typeof value === "object"
        ? row.id > (value as { gt: string }).gt
        : key === "createdAt" && typeof value === "object"
          ? row.createdAt <= (value as { lte: Date }).lte
          : row[key as keyof typeof row] === value,
    );
  const findMany = vi.fn(async (query) =>
    rows
      .filter((row) => matches(row, query.where))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, query.take)
      .map((row) =>
        Object.fromEntries(
          Object.keys(query.select).map((key) => [key, row[key as keyof typeof row]]),
        ),
      ),
  );
  const findFirst = vi.fn(async (query) => rows.find((row) => matches(row, query.where)) ?? null);
  const count = vi.fn(async (query) => rows.filter((row) => matches(row, query.where)).length);
  return {
    db: { memoryDocument: { findMany, findFirst, count } } as never,
    findMany,
    findFirst,
    rows,
    count,
  };
}
describe("memory documents", () => {
  it("lists metadata without selecting or returning content", async () => {
    const { db, findMany } = fixture();
    const result = await listMemoryDocuments(db, actor, {});
    expect(result.documents).toHaveLength(3);
    expect(result.documents[0]).not.toHaveProperty("content");
    expect(findMany.mock.calls[0]![0].select).not.toHaveProperty("content");
  });
  it("lists every page once with a null cursor on the last page", async () => {
    const { db, findMany } = fixture();
    const first = await listMemoryDocuments(db, actor, { limit: 2 });
    const last = await listMemoryDocuments(db, actor, { limit: 2, cursor: first.nextCursor! });
    const ids = [...first.documents, ...last.documents].map((doc) => doc.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(new Set(ids).size).toBe(3);
    expect(first.nextCursor).toBe("b");
    expect(last.nextCursor).toBeNull();
    expect(findMany.mock.calls[0]![0]).toMatchObject({ orderBy: { id: "asc" }, take: 3 });
    for (const limit of [undefined, 0, -1, 1.5, Number.NaN]) {
      await listMemoryDocuments(db, actor, { limit });
      expect(findMany.mock.lastCall![0].take).toBe(101);
    }
    await listMemoryDocuments(db, actor, { limit: 999 });
    expect(findMany.mock.lastCall![0].take).toBe(201);
  });
  it("reads a single scoped path and isolates other spaces", async () => {
    const { db, findFirst } = fixture();
    expect(
      await readMemoryDocument(db, actor, { scope: "bot", botId: "bot-a", path: "a.md" }),
    ).toMatchObject({ content: "body-a" });
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: "bot-a",
      path: "a.md",
    });
    expect(
      await readMemoryDocument(db, actor, { scope: "bot", botId: "other", path: "a.md" }),
    ).toBeNull();
    await expect(readMemoryDocument(db, actor, { scope: "bot", path: "a.md" })).rejects.toThrow();
    expect(await readMemoryDocument(db, actor, { scope: "user", path: "a.md" })).toBeNull();
  });
  it("sorts, reports total and truncation, and exports every page once", async () => {
    const { db, findMany } = fixture();
    const first = await exportMemoryMarkdown(db, actor, { limit: 2 });
    expect(first).toEqual({
      markdown: "# a.md\n\nbody-a\n\n# b.md\n\nbody-b",
      count: 2,
      total: 3,
      truncated: true,
      nextCursor: expect.stringMatching(/^v1:/),
    });
    const last = await exportMemoryMarkdown(db, actor, { limit: 2, cursor: first.nextCursor! });
    expect(last).toEqual({
      markdown: "# c.md\n\nbody-c",
      count: 1,
      total: 3,
      truncated: false,
      nextCursor: null,
    });
    expect(findMany.mock.calls[0]![0]).toMatchObject({ orderBy: { id: "asc" }, take: 3 });
    expect(await exportMemoryMarkdown(db, actor, { botId: "missing" })).toEqual({
      markdown: "",
      count: 0,
      total: 0,
      truncated: false,
      nextCursor: null,
    });
  });
  it("keeps the export boundary across pages and accepts legacy cursors", async () => {
    const { db, rows, count, findMany } = fixture();
    const boundary = new Date("2026-06-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(boundary);
    try {
      rows.push({ ...docs[0]!, id: "d", path: "d.md", content: "body-d", createdAt: boundary });
      const first = await exportMemoryMarkdown(db, actor, { limit: 2 });
      vi.setSystemTime(new Date(boundary.getTime() + 1000));
      rows.push({ ...docs[0]!, id: "z", createdAt: new Date() });
      const last = await exportMemoryMarkdown(db, actor, { limit: 2, cursor: first.nextCursor! });
      expect(first.count).toBe(2);
      expect(first.total).toBe(4);
      expect(last).toEqual({
        markdown: "# c.md\n\nbody-c\n\n# d.md\n\nbody-d",
        count: 2,
        total: 4,
        truncated: false,
        nextCursor: null,
      });
      expect(count.mock.lastCall![0].where.createdAt).toEqual({ lte: boundary });
      expect(findMany.mock.lastCall![0].where).toMatchObject({
        createdAt: { lte: boundary },
        id: { gt: "b" },
      });
      const legacy = await exportMemoryMarkdown(db, actor, { cursor: "b", limit: 2 });
      expect(legacy.total).toBe(5);
      expect(legacy.nextCursor).toBe("d");
      expect(count.mock.lastCall![0].where).not.toHaveProperty("createdAt");
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects malformed export cursors before querying", async () => {
    const { db, findMany, count } = fixture();
    for (const cursor of [
      "",
      "bad|cursor",
      "v1:!",
      ...[
        "invalid|b",
        "2026-02-30T00:00:00.000Z|b",
        "2026-01-01T00:00:00.000Z|",
        "2026-01-01T00:00:00.000Z|b|extra",
      ].map((value) => `v1:${Buffer.from(value).toString("base64url")}`),
    ]) {
      await expect(exportMemoryMarkdown(db, actor, { cursor })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });
  it("caps requests to 100 rows", async () => {
    const { db, findMany } = fixture();
    await exportMemoryMarkdown(db, actor, { limit: 999 });
    expect(findMany.mock.calls[0]![0].take).toBe(101);
  });
});
