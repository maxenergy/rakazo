import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { PrismaClient } from "@rakazo/db";

export interface WorkerIdentity {
  scenarioId: string;
  instanceId: string;
  runId: string;
  attemptId: string | null;
  fence: number;
}
export interface FaultEvent extends WorkerIdentity {
  kind: "ready" | "reached" | "drained" | "error";
  boundary: string;
  sequence: number;
  utc: string;
  elapsedMs: number;
  pid: number;
}
export function requirePrivateDatabase(url: string) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !parsed.port ||
    parsed.port === "5432" ||
    !/^rak_t_[a-z0-9_]{1,40}$/.test(parsed.pathname.slice(1))
  )
    throw new Error("Fault harness requires a private disposable database");
}
function send(child: ChildProcess, message: unknown) {
  return new Promise<void>((resolve, reject) => {
    child.send(message as object, (error) => (error ? reject(error) : resolve()));
  });
}

/** Each handle owns one real process; no crash path invokes drain. */
export async function spawnFaultWorker(input: {
  entry: string;
  databaseUrl: string;
  identity: Omit<WorkerIdentity, "attemptId" | "fence">;
  env?: Record<string, string>;
  timeoutMs?: number;
}) {
  requirePrivateDatabase(input.databaseUrl);
  const child = fork(input.entry, [], {
    execArgv: ["--import", "tsx"],
    env: {
      PATH: process.env.PATH,
      ...input.env,
      LOG_LEVEL: "off",
      RAK_FAULT_CONFIG: JSON.stringify({ ...input.identity, databaseUrl: input.databaseUrl }),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr?.resume();
  const events: FaultEvent[] = [];
  const listeners = new Set<() => void>();
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let processError: Error | undefined;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      resolve(exited);
      for (const listener of listeners) listener();
    });
  });
  child.once("error", (error) => {
    processError = error;
    for (const listener of listeners) listener();
  });
  child.on("message", (message: FaultEvent) => {
    if (
      message.scenarioId !== input.identity.scenarioId ||
      message.instanceId !== input.identity.instanceId ||
      message.runId !== input.identity.runId ||
      message.pid !== child.pid ||
      message.sequence !== events.length + 1
    ) {
      processError = new Error("Invalid fault-worker identity or sequence");
    } else events.push(message);
    for (const listener of listeners) listener();
  });
  async function waitFor(
    kind: FaultEvent["kind"],
    boundary?: string,
    signal?: AbortSignal,
  ): Promise<FaultEvent> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error, event?: FaultEvent) => {
        clearTimeout(timer);
        listeners.delete(check);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(event!);
      };
      const abort = () => finish(new Error("Fault wait cancelled"));
      const check = () => {
        if (processError) return finish(processError);
        const failure = events.find((event) => event.kind === "error");
        if (failure) return finish(new Error("Fault worker failed"));
        const event = events.find(
          (event) => event.kind === kind && (boundary === undefined || event.boundary === boundary),
        );
        if (event) return finish(undefined, event);
        if (exited) finish(new Error("Worker exited before requested boundary"));
      };
      timer = setTimeout(
        () =>
          finish(
            new Error(
              "Fault boundary timed out: " +
                kind +
                "/" +
                boundary +
                "; reached " +
                events.map((event) => event.boundary).join(","),
            ),
          ),
        input.timeoutMs ?? 10_000,
      );
      listeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
  }
  async function exitWithin() {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Worker exit timed out"));
          }, input.timeoutMs ?? 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  const handle = {
    child,
    events,
    exit,
    waitFor,
    async release(event: FaultEvent) {
      if (event.kind !== "reached" || !events.includes(event))
        throw new Error("Release requires this worker's reached event");
      await send(child, { kind: "release", sequence: event.sequence });
    },
    async kill() {
      if (!exited && !child.kill("SIGKILL")) throw new Error("SIGKILL was not delivered");
      const result = await exitWithin();
      assert.deepEqual(result, { code: null, signal: "SIGKILL" });
      assert.equal(
        events.some((event) => event.kind === "drained"),
        false,
      );
      return result;
    },
    async drain() {
      await send(child, { kind: "drain" });
      await waitFor("drained");
      const result = await exitWithin();
      assert.deepEqual(result, { code: 0, signal: null });
      return result;
    },
  };
  try {
    await waitFor("ready");
    return handle;
  } catch (error) {
    if (!exited) child.kill("SIGKILL");
    await exitWithin();
    throw error;
  }
}

/** Test-only IPC barriers. Call only after the real transaction has committed. */
export function faultWorkerChannel(identity: WorkerIdentity, drain: () => Promise<void>) {
  if (!process.send) throw new Error("Fault worker requires IPC");
  const started = performance.now();
  let sequence = 0;
  const pending = new Map<number, () => void>();
  function emit(kind: FaultEvent["kind"], boundary: string) {
    const event: FaultEvent = {
      ...identity,
      kind,
      boundary,
      sequence: ++sequence,
      utc: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      pid: process.pid,
    };
    process.send!(event);
    return event;
  }
  process.on("message", async (message: { kind: string; sequence: number }) => {
    if (message.kind === "release") {
      pending.get(message.sequence)?.();
      pending.delete(message.sequence);
    } else if (message.kind === "drain") {
      try {
        await drain();
        emit("drained", "drain-complete");
        process.disconnect();
      } catch {
        emit("error", "drain-failed");
        process.exitCode = 1;
        process.disconnect();
      }
    }
  });
  return {
    ready: () => emit("ready", "worker-ready"),
    async barrier(
      boundary: string,
      current: Partial<Pick<WorkerIdentity, "attemptId" | "fence">> = {},
    ) {
      Object.assign(identity, current);
      // Register before emit so an immediate controller release cannot be lost.
      const reached = sequence + 1;
      const waiting = new Promise<void>((resolve) => pending.set(reached, resolve));
      emit("reached", boundary);
      await waiting;
    },
    error: () => emit("error", "execution-failed"),
  };
}

/** Private fixture seam; the winner still uses the real continueRun claim path. */
export async function expireWorkerLease(prisma: PrismaClient, runId: string, fence: number) {
  const rows = await prisma.$executeRaw`
    UPDATE runs SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
    WHERE id = ${runId} AND "leaseFence" = ${fence}
  `;
  assert.equal(rows, 1);
  return prisma.run.findUniqueOrThrow({ where: { id: runId } });
}

export async function ledgerSnapshot(prisma: PrismaClient, spaceId: string, callIds: string[]) {
  return prisma.$transaction(
    async (tx) => ({
      usage: await tx.usageRecord.findMany({
        where: { spaceId, callId: { in: callIds } },
        orderBy: { id: "asc" },
      }),
      reservations: await tx.budgetReservation.findMany({
        where: { spaceId, callId: { in: callIds } },
        orderBy: { id: "asc" },
      }),
      settlements: await tx.budgetSpendLedger.findMany({
        where: { spaceId, callId: { in: callIds }, kind: "settled" },
        orderBy: { id: "asc" },
      }),
      effects: await tx.externalEffect.findMany({
        where: { spaceId },
        orderBy: { id: "asc" },
      }),
    }),
    { isolationLevel: "RepeatableRead" },
  );
}
export function assertUniqueBilling(
  snapshot: Awaited<ReturnType<typeof ledgerSnapshot>>,
  calls: Map<string, bigint>,
) {
  assert.equal(snapshot.usage.length, calls.size);
  assert.equal(snapshot.settlements.length, calls.size);
  for (const [callId, amount] of calls) {
    const usage = snapshot.usage.filter((row) => row.callId === callId);
    const settled = snapshot.settlements.filter((row) => row.callId === callId);
    assert.equal(usage.length, 1);
    assert.equal(settled.length, 1);
    assert.equal(usage[0]!.costMicroUsd, amount);
    assert.equal(settled[0]!.amountMicroUsd, amount);
  }
}
export function assertLedgerUnchanged(
  before: Awaited<ReturnType<typeof ledgerSnapshot>>,
  after: Awaited<ReturnType<typeof ledgerSnapshot>>,
) {
  assert.deepEqual(after, before);
}
