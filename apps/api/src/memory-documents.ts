import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

type Db = Pick<PrismaClient, "memoryDocument">;
type Filter = { botId?: string; scope?: "bot" | "user" };
const metadata = {
  id: true,
  scope: true,
  botId: true,
  path: true,
  revision: true,
  updatedAt: true,
} as const;

function where(actor: Actor, filter: Filter) {
  return {
    spaceId: actor.spaceId,
    userId: actor.userId,
    ...(filter.botId ? { botId: filter.botId } : {}),
    ...(filter.scope ? { scope: filter.scope } : {}),
  };
}

export async function listMemoryDocuments(
  db: Db,
  actor: Actor,
  input: Filter & { cursor?: string; limit?: number },
) {
  const limit =
    Number.isInteger(input.limit) && input.limit! > 0 ? Math.min(input.limit!, 200) : 100;
  const docs = await db.memoryDocument.findMany({
    where: { ...where(actor, input), ...(input.cursor ? { id: { gt: input.cursor } } : {}) },
    take: limit + 1,
    select: metadata,
    orderBy: { id: "asc" },
  });
  const page = docs.slice(0, limit);
  return {
    documents: page.map((doc) => ({
      ...doc,
      scope: doc.scope as "bot" | "user",
      updatedAt: doc.updatedAt.toISOString(),
    })),
    nextCursor: docs.length > limit ? page[page.length - 1]!.id : null,
  };
}

export async function readMemoryDocument(
  db: Db,
  actor: Actor,
  input: { scope: "bot" | "user"; botId?: string; path: string },
) {
  if (input.scope === "bot" && !input.botId) throw new ORPCError("BAD_REQUEST");
  const doc = await db.memoryDocument.findFirst({
    where: {
      ...where(actor, input),
      botId: input.scope === "bot" ? input.botId : null,
      path: input.path,
    },
    select: { ...metadata, content: true },
  });
  return doc
    ? { ...doc, scope: doc.scope as "bot" | "user", updatedAt: doc.updatedAt.toISOString() }
    : null;
}

export async function exportMemoryMarkdown(
  db: Db,
  actor: Actor,
  input: Filter & { cursor?: string; limit?: number },
) {
  const filter = where(actor, input);
  const limit = Math.min(100, Math.max(1, input.limit ?? 100));
  const [total, docs] = await Promise.all([
    db.memoryDocument.count({ where: filter }),
    db.memoryDocument.findMany({
      where: { ...filter, ...(input.cursor ? { id: { gt: input.cursor } } : {}) },
      orderBy: { id: "asc" },
      take: limit + 1,
      select: { id: true, path: true, content: true },
    }),
  ]);
  const truncated = docs.length > limit;
  const page = docs.slice(0, limit);
  return {
    markdown: page.map((doc) => `# ${doc.path}\n\n${doc.content}`).join("\n\n"),
    count: page.length,
    total,
    truncated,
    nextCursor: truncated ? page[page.length - 1]!.id : null,
  };
}
