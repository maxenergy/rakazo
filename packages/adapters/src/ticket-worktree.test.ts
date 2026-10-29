import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
let seed: string;
let remote: string;
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
function call(
  ref = "RAK-1",
  location = "container",
  repoPath = repo,
  options: Record<string, unknown> = {},
  env = process.env,
) {
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
        const result = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", env });
        if (result.stdout) yield { type: "stdout" as const, data: result.stdout };
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.status ?? 1 };
      },
    },
    { ref, location, repoPath, ...options },
  );
}
function commit(cwd: string) {
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      path.basename(cwd),
    ],
    { stdio: "ignore" },
  );
}
function advanceRemote() {
  commit(seed);
  execFileSync("git", ["-C", seed, "push", remote, "feat/company-os"], { stdio: "ignore" });
  return execFileSync("git", ["-C", seed, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ticket-worktree-"));
  repo = path.join(root, "repo");
  seed = path.join(root, "seed");
  remote = path.join(root, "remote.git");
  mkdirSync(seed);
  execFileSync("git", ["init", "-b", "feat/company-os", seed], { stdio: "ignore" });
  commit(seed);
  execFileSync("git", ["clone", "--bare", seed, remote], { stdio: "ignore" });
  execFileSync("git", ["clone", remote, repo], { stdio: "ignore" });
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
  const before = git("rev-parse", "origin/feat/company-os");
  advanceRemote();
  git("remote", "set-url", "origin", path.join(root, "unavailable"));
  expect(await call()).toMatchObject({ path: path.join(root, "wt/RAK-1"), reused: true });
  expect(git("rev-parse", "origin/feat/company-os")).toBe(before);
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

it("fetches the latest remote base instead of using HEAD or a stale tracking ref", async () => {
  const old = git("rev-parse", "HEAD");
  const latest = advanceRemote();
  expect(git("rev-parse", "origin/feat/company-os")).toBe(old);
  expect(await call()).toMatchObject({ baseSha: latest, headSha: latest, reused: false });
  expect(git("rev-parse", "HEAD")).toBe(old);
  expect(git("rev-parse", "team/rak-1-worktree")).toBe(latest);
});

it("accepts a base branch override or a verified local commit", async () => {
  git("push", "origin", "HEAD:refs/heads/custom-base");
  expect(await call("RAK-1", "container", repo, { baseBranch: "custom-base" })).toMatchObject({
    baseSha: git("rev-parse", "HEAD"),
  });
  git("remote", "set-url", "origin", path.join(root, "unavailable"));
  expect(
    await call("RAK-2", "container", repo, { baseSha: git("rev-parse", "HEAD") }),
  ).toMatchObject({ baseSha: git("rev-parse", "HEAD") });
});

it.each(["equal", "ancestor", "diverged", "occupied"])(
  "handles a %s leftover branch without deleting, resetting, or overwriting",
  async (kind) => {
    const branch = "team/rak-1-worktree";
    if (kind === "diverged") {
      git("switch", "-c", branch);
      commit(repo);
      git("switch", "feat/company-os");
    } else {
      git("branch", branch);
    }
    const tip = git("rev-parse", branch);
    const base = kind === "equal" ? tip : advanceRemote();
    const occupied = path.join(root, "occupied");
    if (kind === "occupied") git("worktree", "add", occupied, branch);
    const before = git("worktree", "list", "--porcelain");
    const result = await call();
    if (kind === "equal" || kind === "ancestor") {
      expect(result).toMatchObject({ baseSha: base, headSha: base });
      expect(git("rev-parse", branch)).toBe(base);
      expect(rows).toHaveLength(1);
    } else {
      expect(result).toHaveProperty("error", expect.stringContaining("Branch conflict:"));
      expect(result).toHaveProperty("error", expect.stringContaining(`tip=${tip}`));
      expect(result).toHaveProperty(
        "error",
        expect.stringContaining(`occupiedPath=${kind === "occupied" ? occupied : "none"}`),
      );
      expect(git("rev-parse", branch)).toBe(tip);
      expect(git("worktree", "list", "--porcelain")).toBe(before);
      expect(existsSync(path.join(root, "wt/RAK-1"))).toBe(false);
      expect(rows).toHaveLength(0);
    }
  },
);

it.each(["failure", "timeout", "missing-commit"])(
  "does not fall back to local HEAD on baseline %s",
  async (kind) => {
    const head = git("rev-parse", "HEAD");
    const tracking = git("rev-parse", "origin/feat/company-os");
    const options = kind === "missing-commit" ? { baseSha: "a".repeat(40) } : {};
    let env = process.env;
    if (kind === "timeout") {
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      // Exercise a real timeout without adding 30 seconds to this offline test.
      writeFileSync(
        path.join(bin, "sleep"),
        '#!/bin/bash\n[ "$1" = 30 ] || exit 2\nexec /bin/sleep 0.1\n',
      );
      writeFileSync(
        path.join(bin, "git"),
        '#!/bin/bash\nif [ "$3" = fetch ]; then exec /bin/bash -c "while :; do :; done"; fi\nexec /usr/bin/git "$@"\n',
      );
      chmodSync(path.join(bin, "sleep"), 0o755);
      chmodSync(path.join(bin, "git"), 0o755);
      env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
    } else if (kind === "failure") {
      git("remote", "set-url", "origin", path.join(root, "unavailable"));
    }
    const result = await call("RAK-1", "container", repo, options, env);
    expect(result).toHaveProperty(
      "error",
      expect.stringContaining(
        kind === "missing-commit"
          ? "not available locally"
          : "Baseline origin/feat/company-os fetch failed",
      ),
    );
    if (kind === "timeout")
      expect(result).toHaveProperty("error", expect.stringContaining("exit 137"));
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("rev-parse", "origin/feat/company-os")).toBe(tracking);
    expect(git("branch", "--list", "team/rak-1-worktree")).toBe("");
    expect(existsSync(path.join(root, "wt/RAK-1"))).toBe(false);
    expect(rows).toHaveLength(0);
  },
);
