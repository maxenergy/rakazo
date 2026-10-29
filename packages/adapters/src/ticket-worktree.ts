import type { ProcessEvent } from "@rakazo/adapter-kit";
import type { ExecutionFence, PrismaClient } from "@rakazo/db";
import {
  assertExecutionFence,
  ensureBoard,
  findTicket,
  StaleExecutionFenceError,
} from "@rakazo/db";

type Deps = {
  prisma: PrismaClient;
  executionFence?: ExecutionFence;
  ticketBoardEnabled?: boolean;
  spaceId: string;
  computer: string;
  location: "host" | "container";
  workspace: string;
  execute: (argv: string[], cwd: string) => AsyncIterable<ProcessEvent>;
};

// All paths are resolved by the selected execution endpoint, never by the worker.
const PROBE = `
set -eu
root=$(pwd -P)
repo=$(cd -- "$1" && pwd -P)
case "$repo/" in "$root/"*) ;; *) echo "Repository is outside this bot workspace." >&2; exit 1;; esac
top=$(git -C "$repo" rev-parse --show-toplevel)
[ "$top" = "$repo" ]
[ -d "$repo/.git" ] && [ ! -L "$repo/.git" ]
common=$(cd -- "$repo/.git" && pwd -P)
[ "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)" = "$common" ]
printf '%s\n' "$repo"
`;

const WORKTREE = `
set -eu
repo=$1
target=$2
branch=$3
mode=$4
parent=$(dirname -- "$target")
[ "$target" = "$(dirname -- "$repo")/wt/$5" ]
if [ "$mode" = create ]; then
  [ ! -e "$target" ] && [ ! -L "$target" ]
  if [ -e "$parent" ] || [ -L "$parent" ]; then
    [ -d "$parent" ] && [ ! -L "$parent" ]
  else
    mkdir -- "$parent"
  fi
  [ "$(cd -- "$parent" && pwd -P)" = "$parent" ]
  mkdir -- "$target"
  git -C "$repo" worktree add -b "$branch" -- "$target" HEAD >&2
fi
[ -d "$target" ] && [ ! -L "$target" ]
[ "$(cd -- "$target" && pwd -P)" = "$target" ]
[ "$(git -C "$target" rev-parse --show-toplevel)" = "$target" ]
[ "$(git -C "$target" symbolic-ref --short HEAD)" = "$branch" ]
[ "$(git -C "$target" rev-parse --path-format=absolute --git-common-dir)" = "$repo/.git" ]
# Also require registration in this main repository, not just a forged .git pointer.
git -C "$repo" worktree list --porcelain | grep -Fqx -- "worktree $target"
`;

async function command(deps: Deps, script: string, args: string[]) {
  let stdout = "";
  let code: number | undefined;
  for await (const event of deps.execute(
    ["bash", "-c", script, "ticket-worktree", ...args],
    deps.workspace,
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") code = event.code;
  }
  if (code !== 0)
    throw new Error("Worktree validation or creation failed; existing paths were not replaced.");
  return stdout.trimEnd();
}

export async function ticketWorktree(deps: Deps, input: Record<string, unknown>) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  if (typeof input.ref !== "string" || !/^[A-Z]+-\d+$/.test(input.ref))
    return { error: "ref must be a ticket reference." };
  if (typeof input.repoPath !== "string" || !input.repoPath || /[\r\n\0]/.test(input.repoPath))
    return { error: "repoPath is required and must be a single path." };
  if (input.location !== deps.location) return { error: "Execution location mismatch." };
  const board = await ensureBoard(deps.prisma, deps.spaceId, deps.executionFence);
  const ticket = await findTicket(deps.prisma, deps.spaceId, board, { ref: input.ref });
  if (!ticket) return { error: "Ticket not found." };
  const ref = `${board.ticketPrefix}-${ticket.number}`;
  if (ref !== input.ref) return { error: "Ticket reference mismatch." };
  try {
    const repo = await command(deps, PROBE, [input.repoPath]);
    if (!repo.startsWith("/") || /[\r\n\0]/.test(repo))
      throw new Error("Invalid execution-end repository path.");
    const parent = repo.slice(0, repo.lastIndexOf("/"));
    const path = `${parent}/wt/${ref}`;
    const branch = `team/rak-${ticket.number}-worktree`;
    return await deps.prisma.$transaction(
      async (tx) => {
        if (deps.executionFence) await assertExecutionFence(tx, deps.executionFence);
        const existing = await tx.ticketWorktree.findUnique({
          where: { ticketId_computer_repo: { ticketId: ticket.id, computer: deps.computer, repo } },
        });
        if (
          existing &&
          (existing.location !== deps.location ||
            existing.path !== path ||
            existing.branch !== branch)
        )
          throw new Error("Recorded worktree does not match this execution endpoint.");
        if (!existing) {
          // Reserve first: a unique-constraint collision must fail, never reuse or rebuild.
          await tx.ticketWorktree.create({
            data: {
              ticketId: ticket.id,
              computer: deps.computer,
              location: deps.location,
              repo,
              path,
              branch,
            },
          });
        }
        await command(deps, WORKTREE, [repo, path, branch, existing ? "verify" : "create", ref]);
        if (deps.executionFence) await assertExecutionFence(tx, deps.executionFence);
        return { path, branch, reused: Boolean(existing), location: deps.location };
      },
      { timeout: 45_000 },
    );
  } catch (error) {
    if (error instanceof StaleExecutionFenceError) throw error;
    return { error: error instanceof Error ? error.message : "Worktree creation failed." };
  }
}
