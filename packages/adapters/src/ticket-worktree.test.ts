import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ticketWorktree } from "./ticket-worktree.js";

vi.mock("@rakazo/db", () => ({
  assertExecutionFence: vi.fn(),
  StaleExecutionFenceError: class extends Error {},
  ensureBoard: async () => ({ id: "board", ticketPrefix: "RAK" }),
  findTicket: async (_db: unknown, _space: string, _board: unknown, input: { ref: string }) =>
    /^RAK-[12]$/.test(input.ref) ? { id: input.ref, number: Number(input.ref.slice(4)) } : null,
}));

let root: string;
let repo: string;
type Row = {
  ticketId: string;
  computer: string;
  repo: string;
  path: string;
  branch: string;
  location: string;
};
let rows: Row[];
function git(...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function call(ref = "RAK-1", location = "container", repoPath = repo) {
  const tx = {
    ticketWorktree: {
      findUnique: async ({ where }: { where: { ticketId_computer_repo: Partial<Row> } }) =>
        rows.find((row) =>
          Object.entries(where.ticketId_computer_repo).every(
            ([key, value]) => row[key as keyof Row] === value,
          ),
        ),
      create: async ({ data }: { data: Row }) => {
        rows.push(data);
        return data;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      const previous = [...rows];
      try {
        return await fn(tx);
      } catch (error) {
        rows = previous;
        throw error;
      }
    },
  } as unknown as PrismaClient;
  return ticketWorktree(
    {
      prisma,
      spaceId: "space",
      computer: "computer",
      location: "container",
      workspace: root,
      ticketBoardEnabled: true,
      async *execute(argv, cwd) {
        const result = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" });
        if (result.stdout) yield { type: "stdout" as const, data: result.stdout };
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.status ?? 1 };
      },
    },
    { ref, location, repoPath },
  );
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ticket-worktree-"));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  git("init");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  rows = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("isolates two tickets and reuses the same ticket without losing changes", async () => {
  const first = await call();
  const second = await call("RAK-2");
  expect(first).toMatchObject({ path: path.join(root, "wt/RAK-1"), reused: false });
  expect(second).toMatchObject({ path: path.join(root, "wt/RAK-2"), reused: false });
  writeFileSync(path.join(root, "wt/RAK-1/change"), "first");
  writeFileSync(path.join(root, "wt/RAK-2/change"), "second");
  expect(await call()).toMatchObject({ path: path.join(root, "wt/RAK-1"), reused: true });
  expect(readFileSync(path.join(root, "wt/RAK-1/change"), "utf8")).toBe("first");
  expect(readFileSync(path.join(root, "wt/RAK-2/change"), "utf8")).toBe("second");
  expect(rows).toHaveLength(2);
});
it("does not overwrite a directory without a record", async () => {
  mkdirSync(path.join(root, "wt/RAK-1"), { recursive: true });
  writeFileSync(path.join(root, "wt/RAK-1/keep"), "keep");
  expect(await call()).toHaveProperty("error");
  expect(readFileSync(path.join(root, "wt/RAK-1/keep"), "utf8")).toBe("keep");
  expect(rows).toHaveLength(0);
});
it("fails instead of rebuilding a missing recorded directory", async () => {
  await call();
  rmSync(path.join(root, "wt/RAK-1"), { recursive: true });
  expect(await call()).toHaveProperty("error");
  expect(rows).toHaveLength(1);
});
it("rejects a different branch and leaves it unchanged", async () => {
  await call();
  execFileSync("git", ["-C", path.join(root, "wt/RAK-1"), "switch", "-c", "other"]);
  expect(await call()).toHaveProperty("error");
  expect(
    execFileSync("git", ["-C", path.join(root, "wt/RAK-1"), "branch", "--show-current"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("other");
});
it("rejects recorded path and execution endpoint mismatches", async () => {
  await call();
  rows[0]!.path += "-wrong";
  expect(await call()).toHaveProperty("error");
  rows[0]!.path = path.join(root, "wt/RAK-1");
  rows[0]!.location = "host";
  expect(await call()).toHaveProperty("error");
  expect(await call("RAK-1", "host")).toHaveProperty("error");
});
it("requires a real ticket and a main repository within the bot workspace", async () => {
  expect(await call("RAK-999")).toHaveProperty("error");
  expect(await call("RAK-1;echo")).toHaveProperty("error");
  await call();
  expect(await call("RAK-2", "container", path.join(root, "wt/RAK-1"))).toHaveProperty("error");
  expect(rows).toHaveLength(1);
});
