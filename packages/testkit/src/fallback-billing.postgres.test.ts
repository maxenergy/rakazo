import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBudgetObserver } from "../../adapters/src/budget-observer.js";
import { currentBudgetScope } from "../../adapters/src/budget-scope.js";

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

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: (options?: { credentials?: unknown }) => {
    if (options?.credentials) providerState.credentialStores.push(options.credentials);
    return {
      getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
      streamSimple: (...args: unknown[]) => providerState.stream(...args),
    };
  },
}));

vi.mock("../../adapters/src/pi-current-models.js", () => ({
  supplementPiModels: (models: unknown) => models,
}));
vi.mock("../../adapters/src/cli-model-provider.js", () => ({
  registerCliModelProviders: (models: unknown) => models,
}));

vi.mock("../../adapters/src/pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));
vi.mock("../../adapters/src/pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import {
  createDb,
  decideOverrunApproval,
  recordUsage,
  releaseBudgetReservation,
  requestOverrunApproval,
  reserveBudget,
  setProjectBudget,
  startBudgetReservation,
} from "@rakazo/db";
import { PiAgentRuntime } from "../../adapters/src/pi-runtime.js";

const primary = model("provider-a", "primary", 32_768);
const backupA = model("provider-b", "backup-a", 8_192);
const backupB = model("provider-c", "backup-b", 16_384);

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

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("fallback billing PostgreSQL", () => {
  it("case 3: persists physical fallback billed amounts once across parent child observation and replay", async () => {
    let db: ReturnType<typeof createDb> | undefined;
    try {
      db = createDb(process.env.DATABASE_URL!);
      const prisma = db.prisma;
      const organizationId = `case3-${crypto.randomUUID()}`;
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Synthetic case 3",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      const space = await prisma.space.create({
        data: { id: `space-${organizationId}`, organizationId, name: "Synthetic fallback space" },
      });
      const project = await prisma.project.create({
        data: { spaceId: space.id, name: "Synthetic fallback project" },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: space.id, userId: "case3-user", name: "Synthetic bot", color: "#000000" },
      });
      const thread = await prisma.thread.create({
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
      const parent = await prisma.run.create({ data: runData });
      const child = await prisma.run.create({
        data: { ...runData, parentRunId: parent.id, rootRunId: parent.id },
      });
      await setProjectBudget(prisma, {
        spaceId: space.id,
        projectId: project.id,
        limitMicroUsd: 1000000n,
      });
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
            primaryCall ? "503 synthetic unavailable" : undefined,
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
      const runtime = new PiAgentRuntime();
      const events: AgentRuntimeEvent[] = [];
      for await (const event of runtime.run(input, {
        traceId: "case3",
        spaceId: space.id,
        userId: "case3-user",
        signal: new AbortController().signal,
      }))
        events.push(event);
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
        parentRunId: parent.id,
        rootRunId: parent.id,
      };
      for (const event of usage) {
        const reservation = await reserveBudget(prisma, {
          spaceId: space.id,
          projectId: project.id,
          callId: event.callId!,
          amountMicroUsd: 400000n,
        });
        expect(reservation.ok).toBe(true);
        await recordUsage(prisma, event, attribution);
        // Parent aggregation observes the child's physical call with its original attribution.
        await recordUsage(prisma, event, attribution);
        await recordUsage(prisma, event, attribution);
      }
      const rows = await prisma.usageRecord.findMany({
        where: { spaceId: space.id, projectId: project.id },
        orderBy: { costMicroUsd: "asc" },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.costMicroUsd)).toEqual([125001n, 250002n]);
      expect(new Set(rows.map((row) => row.callId))).toEqual(
        new Set(usage.map((event) => event.callId)),
      );
      for (const row of rows)
        expect(row).toMatchObject({
          runId: child.id,
          parentRunId: parent.id,
          rootRunId: parent.id,
        });
      const budget = await prisma.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId: space.id, projectId: project.id } },
      });
      expect(budget.settledMicroUsd).toBe(375003n);
      expect(budget.reservedMicroUsd).toBe(0n);
    } finally {
      vi.unstubAllGlobals();
      if (db) {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  }, 120000);
  it("keeps backup unstarted on selection persistence failure and deduplicates usage after reconnect", async () => {
    let db: ReturnType<typeof createDb> | undefined;
    try {
      db = createDb(process.env.DATABASE_URL!);
      const prisma = db.prisma;
      const organizationId = `case3-${crypto.randomUUID()}`;
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Synthetic case 3",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      const space = await prisma.space.create({
        data: { id: `space-${organizationId}`, organizationId, name: "Synthetic fallback space" },
      });
      const project = await prisma.project.create({
        data: { spaceId: space.id, name: "Synthetic fallback project" },
      });
      const bot = await prisma.bot.create({
        data: { spaceId: space.id, userId: "case3-user", name: "Synthetic bot", color: "#000000" },
      });
      const thread = await prisma.thread.create({
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
      const parent = await prisma.run.create({ data: runData });
      const child = await prisma.run.create({
        data: { ...runData, parentRunId: parent.id, rootRunId: parent.id },
      });
      await setProjectBudget(prisma, {
        spaceId: space.id,
        projectId: project.id,
        limitMicroUsd: 1000000n,
      });
      const approval = await requestOverrunApproval(prisma, {
        spaceId: space.id,
        projectId: project.id,
        amountMicroUsd: 100000n,
        scope: "fallback recovery fixture",
        requestKey: crypto.randomUUID(),
      });
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
            primaryCall ? "503 synthetic unavailable" : undefined,
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
      input.onModelChange = vi.fn(async () => {
        throw new Error("fixture selection persistence failed");
      });
      input.budgetScope = { spaceId: space.id, projectId: project.id };
      const runtime = new PiAgentRuntime({
        modelCallObserver: createBudgetObserver({
          scope: currentBudgetScope,
          upperBoundMicroUsd: () => 400000n,
          port: {
            reserve: (value) => reserveBudget(prisma, value),
            start: (value) => startBudgetReservation(prisma, value),
            release: (value) => releaseBudgetReservation(prisma, value),
          },
        }),
      });
      const events: AgentRuntimeEvent[] = [];
      await expect(
        (async () => {
          for await (const event of runtime.run(input, {
            traceId: "selection-failure",
            spaceId: space.id,
            userId: "case3-user",
            signal: new AbortController().signal,
          }))
            events.push(event);
        })(),
      ).rejects.toThrow("fixture selection persistence failed");
      expect(input.onModelChange).toHaveBeenCalledTimes(1);
      const usage = events.filter(
        (event): event is Extract<AgentRuntimeEvent, { type: "usage" }> => event.type === "usage",
      );
      expect(providerState.stream).toHaveBeenCalledTimes(1);
      expect(usage).toHaveLength(1);
      expect(new Set(usage.map((event) => event.callId)).size).toBe(1);
      const attribution = {
        spaceId: space.id,
        projectId: project.id,
        userId: "case3-user",
        botId: bot.id,
        runId: child.id,
        parentRunId: parent.id,
        rootRunId: parent.id,
      };
      const held = await prisma.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId: space.id, projectId: project.id } },
      });
      expect(held.reservedMicroUsd).toBe(400000n);
      expect(held.settledMicroUsd).toBe(0n);
      await db.prisma.$disconnect();
      await db.pool.end();
      db = createDb(process.env.DATABASE_URL!);
      const recovered = db.prisma;
      const restoredApproval = await recovered.budgetOverrunApproval.findUniqueOrThrow({
        where: { id: approval.id },
      });
      expect(restoredApproval).toMatchObject({
        projectId: project.id,
        budgetVersion: approval.budgetVersion,
        amountMicroUsd: 100000n,
        scope: "fallback recovery fixture",
        status: "pending",
      });
      const decision = {
        spaceId: space.id,
        approvalId: approval.id,
        decision: "approved" as const,
        decidedByUserId: "fixture-reviewer",
      };
      await decideOverrunApproval(recovered, decision);
      await decideOverrunApproval(recovered, decision);

      const recoveredHolding = await recovered.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId: space.id, projectId: project.id } },
      });
      expect(recoveredHolding.reservedMicroUsd).toBe(400000n);
      for (const event of usage) {
        await recordUsage(recovered, event, attribution);
        await recordUsage(recovered, event, attribution);
      }

      for (const event of usage) await recordUsage(recovered, event, attribution);
      const rows = await recovered.usageRecord.findMany({
        where: { spaceId: space.id, projectId: project.id },
        orderBy: { costMicroUsd: "asc" },
      });
      expect(rows).toHaveLength(1);
      expect(rows.map((row) => row.costMicroUsd)).toEqual([125001n]);
      expect(new Set(rows.map((row) => row.callId))).toEqual(
        new Set(usage.map((event) => event.callId)),
      );
      for (const row of rows)
        expect(row).toMatchObject({
          projectId: project.id,
          runId: child.id,
          parentRunId: parent.id,
          rootRunId: parent.id,
        });
      const budget = await recovered.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId: space.id, projectId: project.id } },
      });
      expect(budget.limitMicroUsd).toBe(1100000n);
      expect(budget.settledMicroUsd).toBe(125001n);
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
