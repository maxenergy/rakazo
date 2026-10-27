import { appendFile, readFile, writeFile } from "node:fs/promises";
import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { UsageReplayConflictError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideOverrunApproval,
  requestOverrunApproval,
} from "../../db/src/budget-overrun-approvals.js";
import { holdAfterUsageCommit } from "./fallback-restart-process-barrier.js";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  credentialStores: [] as unknown[],
  stream: vi.fn(),
  agentOptions: undefined as AgentOptions | undefined,
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCore>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: AgentOptions) {
        super(options);
        providerState.agentOptions = options;
      }
    },
  };
});

vi.mock("@earendil-works/pi-ai/providers/all", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/providers/all")>();
  return {
    ...actual,
    builtinModels: (options?: Parameters<typeof actual.builtinModels>[0]) => {
      if (options?.credentials) providerState.credentialStores.push(options.credentials);
      const models = actual.builtinModels(options);
      const originalGetModel = models.getModel.bind(models);
      models.getModel = ((provider: string, id: string) =>
        providerState.models.get(`${provider}/${id}`) ??
        originalGetModel(provider, id)) as typeof models.getModel;
      models.streamSimple = ((...args: unknown[]) =>
        providerState.stream(...args)) as typeof models.streamSimple;
      return models;
    },
  };
});

import {
  createDb,
  recordUsage,
  releaseBudgetReservation,
  reserveBudget,
  setProjectBudget,
  startBudgetReservation,
} from "@rakazo/db";
import { createBudgetObserver } from "../../adapters/src/budget-observer.js";
import type { PiAgentRuntime } from "../../adapters/src/pi-runtime.js";

const primary = model("provider-a", "primary", 262_144);
const backupA = model("openai-compatible", "backup-a", 262_144);
const backupB = model("provider-c", "backup-b", 262_144);

function model(provider: string, id: string, contextWindow: number): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(4_096, contextWindow),
  };
}

function message(
  target: Model<"openai-completions">,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: target.api,
    provider: target.provider,
    model: target.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function stream(_target: Model<"openai-completions">, response: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    result.push({
      type: "error",
      reason: response.stopReason,
      error: response,
    });
  } else if (response.content.some((part) => part.type === "toolCall")) {
    const call = response.content.find((part) => part.type === "toolCall");
    if (call?.type === "toolCall") {
      result.push({
        type: "toolcall_start",
        contentIndex: 0,
        partial: { ...response, content: [] },
      });
      result.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: call,
        partial: response,
      });
    }
    result.push({ type: "done", reason: "toolUse", message: response });
  } else {
    result.push({ type: "done", reason: "stop", message: response });
  }
  result.end(response);
  return result;
}

function request(fallbackModels: AgentRunRequest["model"][] = []): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Write the requested result",
    instructions: "Use tools when useful.",
    history: [],
    tools: [
      {
        name: "write_effect",
        description: "Write one external effect.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        readOnly: false,
      },
    ],
    model: { provider: primary.provider, id: primary.id, apiKey: "fake-primary-key" },
    fallbackModels,
    executeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as AgentRunRequest;
}

beforeEach(() => {
  providerState.models.clear();
  providerState.credentialStores.length = 0;
  for (const candidate of [primary, backupA, backupB]) {
    providerState.models.set(
      `${candidate.provider}/${candidate.id}`,
      candidate as unknown as Record<string, unknown>,
    );
  }
  providerState.stream.mockReset();
  providerState.agentOptions = undefined;
  vi.restoreAllMocks();
});

const enabled =
  Boolean(process.env.RAK19_WORKER_PHASE) &&
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("fallback billing PostgreSQL", () => {
  it("characterizes primary retry after process death between durable usage and fallback", async () => {
    const { PiAgentRuntime } = await import("../../adapters/src/pi-runtime.js");
    let db: ReturnType<typeof createDb> | undefined;
    try {
      db = createDb(process.env.DATABASE_URL!);
      const prisma = db.prisma;
      const phase = process.env.RAK19_WORKER_PHASE;
      const statePath = process.env.RAK19_STATE_PATH;
      if (!statePath || !["crash", "recover"].includes(phase ?? "")) {
        throw new Error("Run through the RAK19 parent coordinator with an isolated database");
      }
      type FixtureState = {
        space: { id: string };
        project: { id: string };
        bot: { id: string };
        thread: { id: string };
        parent: { id: string };
        child: { id: string };
      };
      let space: FixtureState["space"],
        project: FixtureState["project"],
        bot: FixtureState["bot"],
        thread: FixtureState["thread"],
        parent: FixtureState["parent"],
        child: FixtureState["child"];
      if (phase === "recover") {
        ({ space, project, bot, thread, parent, child } = JSON.parse(
          await readFile(statePath, "utf8"),
        ) as FixtureState);
      } else {
        const organizationId = `case3-${crypto.randomUUID()}`;
        await prisma.organization.create({
          data: {
            id: organizationId,
            name: "Synthetic case 3",
            slug: organizationId,
            createdAt: new Date(),
          },
        });
        space = await prisma.space.create({
          data: { id: `space-${organizationId}`, organizationId, name: "Synthetic fallback space" },
        });
        await prisma.user.upsert({
          where: { id: "case3-user" },
          update: {},
          create: { id: "case3-user", name: "Synthetic user", email: "case3@example.invalid" },
        });
        await prisma.member.create({
          data: {
            id: `member-${organizationId}`,
            organizationId,
            userId: "case3-user",
            role: "member",
            createdAt: new Date(),
          },
        });
        await prisma.spaceMember.create({
          data: {
            id: `membership-${organizationId}`,
            organizationId,
            spaceId: space.id,
            userId: "case3-user",
            role: "member",
            createdAt: new Date(),
          },
        });
        project = await prisma.project.create({
          data: { spaceId: space.id, name: "Synthetic fallback project" },
        });
        bot = await prisma.bot.create({
          data: {
            spaceId: space.id,
            userId: "case3-user",
            name: "Synthetic bot",
            color: "#000000",
          },
        });
        const computer = await prisma.computer.create({
          data: {
            spaceId: space.id,
            userId: "case3-user",
            scope: "dedicated",
            scopeKey: `rak19-scope-${bot.id}`,
            homeKey: `rak19-home-${bot.id}`,
            kind: "fake",
            state: "running",
          },
        });
        await prisma.bot.update({ where: { id: bot.id }, data: { computerId: computer.id } });
        thread = await prisma.thread.create({
          data: { spaceId: space.id, botId: bot.id, userId: "case3-user" },
        });
        const task = await prisma.task.create({
          data: {
            spaceId: space.id,
            botId: bot.id,
            threadId: thread.id,
            userId: "case3-user",
            prompt: "Synthetic fallback",
            status: "running",
          },
        });
        const runData = {
          spaceId: space.id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          userId: "case3-user",
          status: "running",
          projectId: project.id,
          trigger: "test",
        };
        parent = await prisma.run.create({ data: runData });
        child = await prisma.run.create({
          data: { ...runData, parentRunId: parent.id, rootRunId: parent.id },
        });
        await setProjectBudget(prisma, {
          spaceId: space.id,
          projectId: project.id,
          limitMicroUsd: 1000000n,
        });
        await writeFile(statePath, JSON.stringify({ space, project, bot, thread, parent, child }), {
          mode: 0o600,
        });
      }
      // RAK19 durable budget approval replay
      // Covers budget decision idempotency, not external tool effect recovery.
      const approvalInput = {
        spaceId: space.id,
        projectId: project.id,
        amountMicroUsd: 100000n,
        scope: "project",
        requestKey: `rak19-restart-${child.id}`,
      };
      const approval = await requestOverrunApproval(prisma, approvalInput);
      const decision = await decideOverrunApproval(prisma, {
        spaceId: space.id,
        approvalId: approval.id,
        decision: "approved",
        decidedByUserId: "case3-user",
      });
      expect(decision.resume).toBe(phase === "crash");
      const replayedApproval = await requestOverrunApproval(prisma, approvalInput);
      expect(replayedApproval.id).toBe(approval.id);
      const approvedBudget = await prisma.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId: space.id, projectId: project.id } },
      });
      expect(approvedBudget.limitMicroUsd).toBe(1100000n);
      const input = request([
        { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-key" },
      ]);
      providerState.stream.mockImplementation((target, _context, options) => {
        return (async function* () {
          const primaryCall = target.id === primary.id;
          const response = message(
            target,
            primaryCall ? [] : [{ type: "text", text: "backup answer" }],
            primaryCall ? "error" : "stop",
            primaryCall ? "503 overloaded" : undefined,
          );
          const cost = primaryCall ? 0.125001 : 0.250002;
          const fetcher = options?.fetch;
          expect(fetcher).toBeTypeOf("function");
          const raw = await fetcher!("https://models.invalid/v1/chat/completions");
          await raw.text();
          response.usage.cost.total = cost;
          yield* stream(target, response);
        })();
      });
      let rawAttempt = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const cost = rawAttempt++ === 0 ? 0.125001 : 0.250002;
          return new Response(
            `data: ${JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost } })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      input.botId = bot.id;
      input.threadId = thread.id;
      input.runId = child.id;
      input.budgetScope = { spaceId: space.id, projectId: project.id };
      const toolMarker = process.env.RAK19_TOOL_MARKER_PATH;
      if (!toolMarker) throw new Error("Missing cross-process tool marker");
      const persisted: AgentRuntimeEvent[] = [];
      const makeRuntime = () =>
        new PiAgentRuntime({
          modelCallObserver: createBudgetObserver({
            port: {
              reserve: (args) => reserveBudget(db!.prisma, args),
              start: (args) => startBudgetReservation(db!.prisma, args),
              release: (args) => releaseBudgetReservation(db!.prisma, args),
            },
            scope: () => ({ spaceId: space.id, projectId: project.id }),
            upperBoundMicroUsd: () => 500000n,
          }),
        });
      const events: AgentRuntimeEvent[] = [];
      // Worker entry uses executor.continueRun; parent orchestration remains unverified.
      const { createRunExecutor } = await import("../../adapters/src/executor.js");
      const { FakeSandboxProvider } = await import("../../adapters/src/fake-sandbox.js");
      const { LocalAgentHomeStore } = await import("../../adapters/src/home.js");
      const { EncryptedSecretStore } = await import("../../adapters/src/secrets.js");
      const { SpaceMemoryProviderResolver } = await import(
        "../../adapters/src/memory-provider-factory.js"
      );
      const { MarkdownMemoryStore } = await import("../../memory/src/index.js");
      const { createThreadEvents } = await import("@rakazo/db");
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const dataDir = await mkdtemp(`${tmpdir()}/rak19-recovery-`);
      const restarted = makeRuntime();
      const { serializeModelSecret } = await import("../../adapters/src/pi-oauth.js");
      const secretStore = new EncryptedSecretStore("offline-rak19-recovery-fixture-key");
      const { aiRecipient } = await import("../../adapters/src/ai-consent.js");
      const { AI_DISCLOSURE_VERSION } = await import("@rakazo/contracts");
      if (phase === "crash") {
        for (const candidate of [primary, backupA]) {
          const sealed = await secretStore.put(
            candidate.provider === "openai-compatible"
              ? serializeModelSecret({
                  kind: "openai_compatible",
                  baseUrl: "https://models.invalid/v1",
                  apiKey: "synthetic-backup-key",
                  visionModelIds: ["backup-a"],
                  contextWindow: 262_144,
                  maxTokens: 4096,
                })
              : "synthetic-offline-key",
            {
              operationId: child.id,
              traceId: child.id,
              spaceId: space.id,
              userId: "case3-user",
              signal: new AbortController().signal,
            },
          );
          await db.prisma.secret.create({
            data: {
              id: sealed.id,
              userId: "case3-user",
              kind: "model",
              ciphertext: sealed.ciphertext,
            },
          });
          const credential = await db.prisma.userModelCredential.create({
            data: {
              userId: "case3-user",
              provider: candidate.provider,
              label: "Synthetic offline credential",
              secretId: sealed.id,
            },
          });
          await db.prisma.spaceModelPreference.create({
            data: {
              spaceId: space.id,
              userId: "case3-user",
              credentialId: credential.id,
              modelId: candidate.id,
              isDefault: candidate.id === primary.id,
            },
          });
        }
        await db.prisma.botBackupModel.create({
          data: {
            botId: bot.id,
            provider: backupA.provider,
            modelId: backupA.id,
            position: 0,
          },
        });
        const recipient = aiRecipient({
          provider: backupA.provider,
          modelId: backupA.id,
          baseUrl: backupA.baseUrl,
          use: "model",
        });
        if (recipient)
          await db.prisma.aiDataConsent.create({
            data: {
              userId: "case3-user",
              spaceId: space.id,
              recipientKey: recipient.key,
              version: AI_DISCLOSURE_VERSION,
            },
          });
      }
      const sandbox = new FakeSandboxProvider();
      const originalWriteFile = sandbox.writeFile.bind(sandbox);
      sandbox.writeFile = async (...args: Parameters<typeof originalWriteFile>) => {
        const result = await originalWriteFile(...args);
        if (args[1].path === "fallback-restart-effect.txt") {
          await appendFile(toolMarker, `${JSON.stringify({ action: "write_file", phase })}\n`);
        }
        return result;
      };
      const makeExecutor = (
        database: ReturnType<typeof createDb>,
        runtime: PiAgentRuntime,
        capturedEvents: AgentRuntimeEvent[],
      ) =>
        createRunExecutor({
          prisma: database.prisma,
          events: createThreadEvents(database.prisma),
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          memory: new MarkdownMemoryStore(database.prisma),
          memoryProviders: new SpaceMemoryProviderResolver(database.prisma, secretStore),
          secretStore,
          secrets: [],
          jobs: {
            enqueue: async () => undefined,
            cancel: async () => undefined,
            close: async () => undefined,
          },
          runtime: {
            describe: () => runtime.describe(),
            abort: (...args) => runtime.abort(...args),
            async *run(recoveredRequest, context) {
              // Replay the same completed tool through the real executor in both processes.
              // Only the first invocation may reach the sandbox side effect.
              if (!recoveredRequest.executeTool)
                throw new Error("Executor must supply executeTool");
              const effect = await recoveredRequest.executeTool(
                "write_file",
                {
                  location: "container",
                  path: "fallback-restart-effect.txt",
                  content: "completed",
                },
                "fallback-restart-completed-action",
              );
              expect(effect).not.toHaveProperty("error");
              const durableOnUsage = recoveredRequest.onUsage;
              if (!durableOnUsage) throw new Error("Executor must supply real onUsage");
              const recovered = {
                ...recoveredRequest,
                onUsage: async (...args: Parameters<NonNullable<typeof durableOnUsage>>) => {
                  await durableOnUsage(...args);
                  if (process.env.RAK19_WORKER_PHASE === "crash") {
                    expect(providerState.stream.mock.calls.map(([target]) => target.id)).toEqual([
                      primary.id,
                    ]);
                    const durable = await database.prisma.usageRecord.findMany({
                      where: { runId: child.id },
                    });
                    expect(durable).toHaveLength(1);
                    expect(durable[0]).toMatchObject({
                      costMicroUsd: 125001n,
                      projectId: project.id,
                      attributedRunId: child.id,
                      parentRunId: child.id,
                      rootRunId: parent.id,
                    });
                    const committedBudget = await database.prisma.projectBudget.findUniqueOrThrow({
                      where: { spaceId_projectId: { spaceId: space.id, projectId: project.id } },
                    });
                    expect(committedBudget.settledMicroUsd).toBe(125001n);
                    expect(committedBudget.reservedMicroUsd).toBe(0n);
                    await holdAfterUsageCommit(durable[0]!.callId!);
                  }
                },
              };
              for await (const event of runtime.run(recovered, context)) {
                capturedEvents.push(event);
                yield event;
              }
            },
          },
        });
      const executor = makeExecutor(db, restarted, events);
      try {
        await db.prisma.run.update({
          where: { id: child.id },
          data: { status: "running", leaseExpiresAt: new Date(0) },
        });
        await executor.continueRun(child.id, "rak19-replacement-worker");
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
      const toolRuns = (await readFile(toolMarker, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(toolRuns).toHaveLength(1);
      expect(toolRuns[0]).toMatchObject({ action: "write_file", phase: "crash" });
      const barrier = JSON.parse(await readFile(process.env.RAK19_BARRIER_PATH!, "utf8")) as {
        callId: string;
      };
      // Characterization: a fresh process retries the primary before fallback.
      expect(providerState.stream.mock.calls.map(([target]) => target.id)).toEqual([
        primary.id,
        backupA.id,
      ]);
      events.push(
        ...persisted.filter(
          (event) =>
            !events.some(
              (seen) =>
                seen.type === "usage" && event.type === "usage" && seen.callId === event.callId,
            ),
        ),
      );
      const usage = events.filter(
        (event): event is Extract<AgentRuntimeEvent, { type: "usage" }> => event.type === "usage",
      );
      expect(providerState.stream).toHaveBeenCalledTimes(2);
      expect(usage).toHaveLength(2);
      expect(new Set(usage.map((event) => event.callId)).size).toBe(2);
      const attribution = {
        spaceId: space.id,
        projectId: project.id,
        userId: "case3-user",
        botId: bot.id,
        runId: child.id,
        parentRunId: child.id,
        rootRunId: parent.id,
      };
      for (const event of usage) {
        const reservation = await reserveBudget(db!.prisma, {
          spaceId: space.id,
          projectId: project.id,
          callId: event.callId!,
          amountMicroUsd: 500000n,
        });
        expect(reservation).toMatchObject({
          ok: false,
          reason: "reservation_closed",
          status: "settled",
        });
        await recordUsage(db!.prisma, event, attribution);
        await expect(
          recordUsage(db!.prisma, event, {
            ...attribution,
            projectId: null,
          }),
        ).rejects.toBeInstanceOf(UsageReplayConflictError);
        // Repeated observations preserve the original physical call attribution.
        await recordUsage(db!.prisma, event, attribution);
        await recordUsage(db!.prisma, event, attribution);
      }
      const rows = await db!.prisma.usageRecord.findMany({
        where: { spaceId: space.id, projectId: project.id },
        orderBy: { costMicroUsd: "asc" },
      });
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.costMicroUsd)).toEqual([125001n, 125001n, 250002n]);
      expect(rows.filter((row) => row.callId === barrier.callId)).toHaveLength(1);
      expect(usage[0]!.callId).not.toBe(barrier.callId);
      expect(rows[2]!.callId).toBe(usage[1]!.callId);
      expect(rows[2]!.costMicroUsd).toBe(250002n);
      const budget = await db!.prisma.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId: space.id, projectId: project.id } },
      });
      expect(budget.settledMicroUsd).toBe(500004n);
      expect(budget.reservedMicroUsd).toBe(0n);
    } finally {
      vi.unstubAllGlobals();
      if (db) {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  }, 120000);
});
