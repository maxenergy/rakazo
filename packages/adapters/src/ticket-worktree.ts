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
  execute: (argv: string[], cwd: string, timeoutMs: number) => AsyncIterable<ProcessEvent>;
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

const BASELINE = `
set -eu
repo=$1
base_branch=$2
base_sha=$3
if [ -n "$base_sha" ]; then
  git -C "$repo" rev-parse --verify "$base_sha^{commit}" ||
    { echo "Baseline commit $base_sha is not available locally." >&2; exit 1; }
else
  git check-ref-format "refs/heads/$base_branch" >/dev/null
  # A failed or timed-out fetch must never fall back to HEAD or a stale remote ref.
  # Bash job control gives fetch and its children a process group on host and container.
  # Do not require GNU timeout, which is absent on a standard macOS host.
  set -m
  git -C "$repo" fetch --no-tags origin "+refs/heads/$base_branch:refs/remotes/origin/$base_branch" >&2 &
  fetch_pid=$!
  (
    sleep 30
    kill -KILL -- "-$fetch_pid" 2>/dev/null || :
  ) </dev/null >/dev/null 2>&1 &
  timer_pid=$!
  cleanup() { kill -TERM -- "-$fetch_pid" "-$timer_pid" 2>/dev/null || :; }
  trap cleanup EXIT
  status=0
  wait "$fetch_pid" || status=$?
  kill -TERM -- "-$timer_pid" 2>/dev/null || :
  wait "$timer_pid" 2>/dev/null || :
  if [ "$status" != 0 ]; then
    echo "Baseline origin/$base_branch fetch failed (exit $status; timeout 30s)." >&2
    exit "$status"
  fi
  git -C "$repo" rev-parse --verify "refs/remotes/origin/$base_branch^{commit}"
fi
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
  base=$6
  [ ! -e "$target" ] && [ ! -L "$target" ]
  reuse=false
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    tip=$(git -C "$repo" rev-parse --verify "refs/heads/$branch^{commit}")
    occupied=$(git -C "$repo" worktree list --porcelain | awk -v ref="refs/heads/$branch" '
      /^worktree / { path=substr($0, 10) }
      $0 == "branch " ref { print path }
    ')
    if [ -n "$occupied" ] || ! git -C "$repo" merge-base --is-ancestor "$tip" "$base"; then
      echo "Branch conflict: branch=$branch tip=$tip occupiedPath=\${occupied:-none} baseline=$base." >&2
      exit 1
    fi
    reuse=true
  fi
  if [ -e "$parent" ] || [ -L "$parent" ]; then
    [ -d "$parent" ] && [ ! -L "$parent" ]
  else
    mkdir -- "$parent"
  fi
  [ "$(cd -- "$parent" && pwd -P)" = "$parent" ]
  if [ "$reuse" = true ]; then
    git -C "$repo" worktree add -- "$target" "$branch" >&2
    # Advance an ancestor branch without deleting or resetting it.
    git -C "$target" merge --ff-only "$base" >&2
  else
    git -C "$repo" worktree add -b "$branch" -- "$target" "$base" >&2
  fi
fi
[ -d "$target" ] && [ ! -L "$target" ]
[ "$(cd -- "$target" && pwd -P)" = "$target" ]
[ "$(git -C "$target" rev-parse --show-toplevel)" = "$target" ]
[ "$(git -C "$target" symbolic-ref --short HEAD)" = "$branch" ]
[ "$(git -C "$target" rev-parse --path-format=absolute --git-common-dir)" = "$repo/.git" ]
# Also require registration in this main repository, not just a forged .git pointer.
git -C "$repo" worktree list --porcelain | grep -Fqx -- "worktree $target"
git -C "$target" rev-parse HEAD
`;

const CHECKOUT = `
set -eu
target=$2
timeout_seconds=$8
set -m
bash -c "$7" ticket-worktree "$@" &
checkout_pid=$!
(
  sleep "$timeout_seconds"
  echo "Worktree checkout timed out after $timeout_seconds seconds; partial worktree retained at $target." >&2
  kill -KILL -- "-$checkout_pid" 2>/dev/null || :
) </dev/null &
timer_pid=$!
cleanup() { kill -TERM -- "-$checkout_pid" "-$timer_pid" 2>/dev/null || :; }
trap cleanup EXIT
status=0
wait "$checkout_pid" || status=$?
kill -TERM -- "-$timer_pid" 2>/dev/null || :
wait "$timer_pid" 2>/dev/null || :
exit "$status"
`;

async function command(deps: Deps, script: string, args: string[], timeoutMs = 35_000) {
  let stdout = "";
  let stderr = "";
  let code: number | undefined;
  for await (const event of deps.execute(
    ["bash", "-c", script, "ticket-worktree", ...args],
    deps.workspace,
    timeoutMs,
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") code = event.code;
  }
  if (code !== 0)
    throw new Error(
      `Worktree validation or creation failed; existing paths were not replaced. ${stderr.trim()}`,
    );
  return stdout.trimEnd();
}

export async function ticketWorktree(deps: Deps, input: Record<string, unknown>) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  if (typeof input.ref !== "string" || !/^[A-Z]+-\d+$/.test(input.ref))
    return { error: "ref must be a ticket reference." };
  if (typeof input.repoPath !== "string" || !input.repoPath || /[\r\n\0]/.test(input.repoPath))
    return { error: "repoPath is required and must be a single path." };
  if (input.location !== deps.location) return { error: "Execution location mismatch." };
  const baseBranch = input.baseBranch ?? "feat/company-os";
  if (typeof baseBranch !== "string" || !baseBranch || /[\r\n\0]/.test(baseBranch))
    return { error: "baseBranch must be a branch name." };
  if (
    input.baseSha !== undefined &&
    (typeof input.baseSha !== "string" || !/^[a-fA-F0-9]{7,64}$/.test(input.baseSha))
  )
    return { error: "baseSha must be a commit SHA available locally." };
  const checkoutTimeoutMs = input.checkoutTimeoutMs ?? 120_000;
  if (
    typeof checkoutTimeoutMs !== "number" ||
    !Number.isSafeInteger(checkoutTimeoutMs) ||
    checkoutTimeoutMs < 1 ||
    checkoutTimeoutMs > 600_000
  )
    return { error: "checkoutTimeoutMs must be an integer between 1 and 600000." };
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
        // A recorded worktree is verified before any fetch or filesystem mutation.
        let baseSha: string | undefined;
        if (!existing) {
          baseSha = await command(deps, BASELINE, [
            repo,
            baseBranch,
            (input.baseSha as string) ?? "",
          ]);
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
        const headSha = await command(
          deps,
          CHECKOUT,
          [
            repo,
            path,
            branch,
            existing ? "verify" : "create",
            ref,
            baseSha ?? "",
            WORKTREE,
            String(checkoutTimeoutMs / 1000),
          ],
          checkoutTimeoutMs + 5_000,
        );
        if (deps.executionFence) await assertExecutionFence(tx, deps.executionFence);
        return {
          path,
          branch,
          reused: Boolean(existing),
          location: deps.location,
          headSha,
          ...(baseSha ? { baseSha } : {}),
        };
      },
      { timeout: checkoutTimeoutMs + 45_000 },
    );
  } catch (error) {
    if (error instanceof StaleExecutionFenceError) throw error;
    return { error: error instanceof Error ? error.message : "Worktree creation failed." };
  }
}
