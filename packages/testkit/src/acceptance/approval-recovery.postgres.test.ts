import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComposioEmulator,
  createBudgetObserver,
  currentBudgetScope,
  FakeSandboxProvider,
  PiAgentRuntime,
} from "@rakazo/adapters";
import { createDb, createDbBudgetPort, expireOverrunApprovals, setProjectBudget } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { discardBotIntroRun } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";
import { type ModelEmulatorStep, startModelEmulator } from "../model-emulator.js";

import {
  type DisposableCluster,
  postgresAvailable,
  startDisposableCluster,
} from "./disposable-postgres.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = postgresAvailable();
if (process.env.RAK_REQUIRE_PG === "1" && !databaseAvailable) {
  throw new Error("RAK_REQUIRE_PG=1 but PostgreSQL binaries are unavailable");
}
const fixtureOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("approval recovery after runtime restart", () => {
  let cluster: DisposableCluster;
  let databaseUrl: string;
  beforeAll(async () => {
    cluster = await startDisposableCluster();
    const database = await cluster.createDatabase("approval_recovery");
    await cluster.migrate(database);
    databaseUrl = cluster.url(database);
    vi.stubEnv("DATABASE_URL", databaseUrl);
  }, 60_000);
  afterAll(async () => {
    await cluster?.stop();
  });
  beforeAll(() => {
    // Use the existing compatible-endpoint capability declaration so the real
    // executor exposes computer tools without mocking its model vision gate.
    vi.stubEnv("RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS", "offline-fixture");
  });
  afterAll(() => vi.unstubAllEnvs());

  it.each(["allow", "deny"] as const)(
    "%s enforces the persisted computer action before any sandbox effect",
    async (answer) => {
      let sandbox: FakeSandboxProvider;
      const approvedArgs = {
        location: "container",
        actions: [{ kind: "type", text: "approved clipboard content" }],
        observe: false,
        settle_ms: 0,
      };
      const resultStep =
        (id: string): ModelEmulatorStep["expect"] =>
        (request) => {
          const result = request.messages.findLast((message) => message.role === "tool");
          expect(result?.tool_call_id).toBe(id);
          const body = JSON.parse(String(result?.content));
          if (answer === "allow") expect(body).toMatchObject({ ok: true, completed: 1 });
          else expect(JSON.stringify(body)).toMatch(/denied/i);
          // Inspect the provider state while the run still owns its screen;
          // completed runs release that screen and discard its placeholder state.
          const screens = [...sandbox.boxes.values()].flatMap((box) => [...box.screens.values()]);
          expect(screens).not.toContain("unapproved replacement");
          if (answer === "allow") expect(screens).toContain("approved clipboard content");
          else expect(screens).not.toContain("approved clipboard content");
        };
      const fixtureKey = "offline-computer-approval-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              expect(request.tools).toContainEqual(
                expect.objectContaining({
                  function: expect.objectContaining({ name: "computer_act" }),
                }),
              );
            },
            response: {
              type: "tool",
              id: "pending-action",
              name: "computer_act",
              arguments: approvedArgs,
            },
          },
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain("approved clipboard content");
            },
            response: {
              type: "tool",
              id: "resumed-action",
              name: "computer_act",
              // The executor must restore exactly what the user approved, even if
              // the model reconstructs different arguments after its run resumes.
              arguments:
                answer === "allow"
                  ? {
                      ...approvedArgs,
                      actions: [{ kind: "type", text: "unapproved replacement" }],
                    }
                  : approvedArgs,
            },
          },
          {
            // A later identical computer_act in this same resume is a new occurrence,
            // not a replay. This fixture only checks the approved request is restored.
            expect: resultStep("resumed-action"),
            response: { type: "text", text: "Finished the approval fixture." },
          },
        ],
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-computer-approval-"));
      let stop: (() => Promise<void>) | undefined;
      try {
        const { createApp } = await import("../../../../apps/api/src/app.ts");
        const startApp = () =>
          createApp({
            databaseUrl: databaseUrl,
            realtimeDatabaseUrl: databaseUrl,
            authUrl: fixtureOrigin,
            webOrigin: fixtureOrigin,
            dataDir,
            sandboxProvider: "fake",
            agentRuntime: "pi",
            wakeupDriver: "memory",
            signupsEnabled: "true",
            composio: new ComposioEmulator(),
            encryptionKey: "offline-computer-fixture-encryption-key",
          });
        let handles = await startApp();
        stop = handles.stop;
        expect(handles.sandbox).toBeInstanceOf(FakeSandboxProvider);
        sandbox = handles.sandbox as FakeSandboxProvider;
        // Keep the real fake-provider implementation; observe calls and its state
        // independently of the model's claims and the persisted effect record.
        const act = vi.spyOn(sandbox, "act");
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: fixtureOrigin },
          body: JSON.stringify({
            email: `computer-approval-${randomUUID()}@rakazo.test`,
            password: "password12",
            name: "Computer approval fixture",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        await rpc(handles.app, cookie, "models/connect", {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
          contextWindow: 160_000,
          maxTokens: 4096,
        });
        const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
          name: "Computer fixture",
          title: "",
          description: "",
          instructions: "Complete the computer task.",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        await rpc(handles.app, cookie, "bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
        });
        const storedBot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
        await handles.prisma.actionApprovalRule.create({
          data: {
            spaceId: storedBot.spaceId,
            createdByUserId: storedBot.userId,
            effect: "require_approval",
            matchKind: "tool",
            matchValue: "computer_act",
          },
        });
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: "Put approved clipboard content on the computer clipboard.",
        });
        const waitForRun = async (status: string) => {
          await expect
            .poll(
              async () => {
                const run = await handles.prisma.run.findUniqueOrThrow({
                  where: { id: sent.runId },
                });
                if (run.status === "failed") model.assertComplete();
                return run.status;
              },
              { timeout: 15_000, interval: 100 },
            )
            .toBe(status);
        };
        await waitForRun("waiting_input");
        expect(model.requests).toHaveLength(1);
        expect(act).not.toHaveBeenCalled();
        const effects = await handles.prisma.externalEffect.findMany({
          where: { runId: sent.runId },
        });
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({
          kind: "computer_act",
          status: "intended",
          request: approvedArgs,
        });
        const card = await handles.prisma.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(card.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "ask", approvalEffectId: effects[0]!.id }),
          ]),
        );
        // Persist the pending approval, close the runtime, and recreate it against the same throwaway DB.
        await handles.stop();
        handles = await startApp();
        stop = handles.stop;
        sandbox = handles.sandbox as FakeSandboxProvider;
        const resumedAct = vi.spyOn(sandbox, "act");
        expect(
          await handles.prisma.externalEffect.findUniqueOrThrow({
            where: { id: effects[0]!.id },
          }),
        ).toMatchObject({ status: "intended", request: approvedArgs });
        expect(resumedAct).not.toHaveBeenCalled();
        await rpc(handles.app, cookie, "threads/answer", {
          botId: bot.id,
          runId: sent.runId,
          messageId: card.id,
          answer,
        });
        await waitForRun("completed");
        model.assertComplete();
        expect(act).not.toHaveBeenCalled();
        expect(resumedAct).toHaveBeenCalledTimes(answer === "allow" ? 1 : 0);
        if (answer === "allow") {
          expect(resumedAct.mock.calls[0]![1]).toEqual({
            actions: [{ kind: "clipboard", text: "approved clipboard content" }],
            observe: false,
            settleMs: 0,
          });
        }
        const settledEffects = await handles.prisma.externalEffect.findMany({
          where: { runId: sent.runId },
        });
        expect(settledEffects).toHaveLength(1);
        expect(settledEffects[0]).toMatchObject({
          id: effects[0]!.id,
          status: answer === "allow" ? "completed" : "denied",
          request: approvedArgs,
        });
      } finally {
        try {
          await stop?.();
        } finally {
          await model.close();
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    },
    90_000,
  );

  it.each(["approve", "deny", "expire"] as const)(
    "budget %s preserves completed effects",
    async (decision) => {
      const bound = 1_000_000n;
      const db = createDb(databaseUrl);
      const dataDir = await mkdtemp(path.join(tmpdir(), "rak-budget-recovery-"));
      const args = {
        location: "container",
        actions: [{ kind: "type", text: "completed budget effect" }],
        observe: false,
        settle_ms: 0,
      };
      const model = await startModelEmulator({
        apiKey: "offline-budget-fixture",
        steps: [
          {
            expect() {},
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 },
            response: { type: "tool", id: "budget-effect", name: "computer_act", arguments: args },
          },
          ...(decision === "approve"
            ? [
                {
                  expect(request: Parameters<ModelEmulatorStep["expect"]>[0]) {
                    expect(JSON.stringify(request.messages)).toContain("budget");
                  },
                  usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18, cost: 0 },
                  response: {
                    type: "tool" as const,
                    id: "budget-effect-replay",
                    name: "computer_act",
                    arguments: args,
                  },
                },
                {
                  expect(request: Parameters<ModelEmulatorStep["expect"]>[0]) {
                    expect(request.messages.some((message) => message.role === "tool")).toBe(true);
                  },
                  usage: { prompt_tokens: 14, completion_tokens: 7, total_tokens: 21, cost: 0.001 },
                  response: { type: "text" as const, text: "Budget recovery completed." },
                },
              ]
            : []),
        ],
      });
      let stop: (() => Promise<void>) | undefined;
      try {
        const { createApp } = await import("../../../../apps/api/src/app.ts");
        const start = () =>
          createApp({
            databaseUrl,
            realtimeDatabaseUrl: databaseUrl,
            authUrl: fixtureOrigin,
            webOrigin: fixtureOrigin,
            dataDir,
            sandboxProvider: "fake",
            agentRuntime: "pi",
            wakeupDriver: "memory",
            signupsEnabled: "true",
            composio: new ComposioEmulator(),
            encryptionKey: "offline-budget-fixture-encryption-key",
            runtime: new PiAgentRuntime({
              sessionRoot: path.join(dataDir, "sessions"),
              modelCallObserver: createBudgetObserver({
                port: createDbBudgetPort(db.prisma),
                scope: currentBudgetScope,
                upperBoundMicroUsd: () => bound,
              }),
            }),
          });
        let handles = await start();
        stop = handles.stop;
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: fixtureOrigin },
          body: JSON.stringify({
            email: `budget-${randomUUID()}@rakazo.test`,
            password: "password12",
            name: "Budget recovery fixture",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        await rpc(handles.app, cookie, "models/connect", {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: "offline-budget-fixture",
          contextWindow: 160_000,
          maxOutputTokens: 4096,
        });
        const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
          name: "Budget fixture",
          title: "",
          description: "",
          instructions: "Complete the computer task.",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        await rpc(handles.app, cookie, "bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
        });
        const stored = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
        const project = await handles.prisma.project.create({
          data: { spaceId: stored.spaceId, name: "Budget recovery" },
        });
        await setProjectBudget(handles.prisma, {
          spaceId: stored.spaceId,
          projectId: project.id,
          limitMicroUsd: 10n * bound,
        });
        const enqueue = handles.jobs.enqueue.bind(handles.jobs);
        vi.spyOn(handles.jobs, "enqueue").mockImplementation(async (job) => {
          if (job.name === "run.continue")
            await handles.prisma.run.update({
              where: { id: (job.payload as { runId: string }).runId },
              data: { projectId: project.id },
            });
          return enqueue(job);
        });
        const sandbox = handles.sandbox as FakeSandboxProvider;
        const originalAct = sandbox.act.bind(sandbox);
        const act = vi.spyOn(sandbox, "act").mockImplementation(async (...input) => {
          const result = await originalAct(...input);
          const budget = await handles.prisma.projectBudget.findUniqueOrThrow({
            where: { spaceId_projectId: { spaceId: stored.spaceId, projectId: project.id } },
          });
          // Leave zero available without changing the version or existing holdings.
          await handles.prisma.projectBudget.update({
            where: { id: budget.id },
            data: { limitMicroUsd: budget.reservedMicroUsd + budget.settledMicroUsd },
          });
          return result;
        });
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: "Type the fixture text, then finish.",
        });
        await expect
          .poll(
            async () =>
              await (async () => {
                const run = await handles.prisma.run.findUniqueOrThrow({
                  where: { id: sent.runId },
                });
                if (run.status === "failed") {
                  model.assertComplete();
                  throw new Error(JSON.stringify(run));
                }
                return run.status;
              })(),
            { timeout: 20_000 },
          )
          .toBe("waiting_budget");
        await handles.awaitIdle?.();
        expect(act).toHaveBeenCalledTimes(1);
        expect(model.requests).toHaveLength(1);
        const effects = await handles.prisma.externalEffect.findMany({
          where: { runId: sent.runId },
        });
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({ status: "completed", request: args });
        const usage = await handles.prisma.usageRecord.findMany({
          where: { runId: sent.runId },
          orderBy: { id: "asc" },
        });
        expect(usage).toHaveLength(1);
        const ledger = await handles.prisma.budgetSpendLedger.findMany({
          where: { projectId: project.id },
          orderBy: { id: "asc" },
        });
        const reservations = await handles.prisma.budgetReservation.findMany({
          where: { projectId: project.id },
          orderBy: { id: "asc" },
        });
        const paused = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        expect(paused.segmentCheckpoint).toBeNull();
        const approval = await handles.prisma.budgetOverrunApproval.findFirstOrThrow({
          where: { projectId: project.id },
        });
        expect(approval.amountMicroUsd).toBe(bound);
        expect(approval.proposalId).toBeTruthy();
        // Orderly application restart; this does not simulate a crash.
        await handles.stop();
        stop = undefined;
        handles = await start();
        stop = handles.stop;
        const resumedAct = vi.spyOn(handles.sandbox as FakeSandboxProvider, "act");
        if (decision === "expire") {
          await handles.prisma.budgetOverrunApproval.update({
            where: { id: approval.id },
            data: { expiresAt: new Date(0) },
          });
          await expireOverrunApprovals(handles.prisma);
          await expireOverrunApprovals(handles.prisma);
        } else {
          await rpc(handles.app, cookie, "proposals/decide", {
            proposalId: approval.proposalId,
            decision: decision === "approve" ? "approve" : "reject",
          });
        }
        if (decision === "approve")
          await expect
            .poll(
              async () =>
                await (async () => {
                  const run = await handles.prisma.run.findUniqueOrThrow({
                    where: { id: sent.runId },
                  });
                  if (run.status === "failed") {
                    model.assertComplete();
                    throw new Error(JSON.stringify(run));
                  }
                  return run.status;
                })(),
              { timeout: 20_000 },
            )
            .toBe("completed");
        await handles.awaitIdle?.();
        expect(resumedAct).not.toHaveBeenCalled();
        expect(
          await handles.prisma.externalEffect.findMany({ where: { runId: sent.runId } }),
        ).toEqual(effects);
        const afterUsage = await handles.prisma.usageRecord.findMany({
          where: { runId: sent.runId },
          orderBy: { id: "asc" },
        });
        const afterLedger = await handles.prisma.budgetSpendLedger.findMany({
          where: { projectId: project.id },
          orderBy: { id: "asc" },
        });
        for (const row of usage) expect(afterUsage).toContainEqual(row);
        const originalCallId = usage[0]!.callId;
        expect(originalCallId).toBeTruthy();
        expect(afterLedger.filter((row) => row.callId === originalCallId)).toEqual(
          ledger.filter((row) => row.callId === originalCallId),
        );
        if (decision === "approve") {
          expect(afterUsage).toHaveLength(3);
          expect(new Set(afterUsage.map((row) => row.callId)).size).toBe(3);
          const subsequent = afterUsage.filter((row) => !usage.some((old) => old.id === row.id));
          expect(subsequent).toHaveLength(2);
          expect(subsequent.some((row) => row.costMicroUsd !== null && row.costMicroUsd > 0n)).toBe(
            true,
          );
          for (const row of subsequent) {
            expect(
              afterLedger.filter(
                (entry) => entry.callId === row.callId && entry.kind === "settled",
              ),
            ).toHaveLength(1);
            expect(afterLedger).toContainEqual(
              expect.objectContaining({
                callId: row.callId,
                kind: "settled",
                amountMicroUsd: row.costMicroUsd,
              }),
            );
            expect(
              await handles.prisma.budgetReservation.findFirstOrThrow({
                where: { projectId: project.id, callId: row.callId! },
              }),
            ).toMatchObject({ status: "settled" });
          }
        } else {
          const terminalStatus = decision === "deny" ? "rejected" : "expired";
          expect(
            await handles.prisma.budgetOverrunApproval.findUniqueOrThrow({
              where: { id: approval.id },
            }),
          ).toMatchObject({ status: terminalStatus });
          expect(
            await handles.prisma.proposal.findUniqueOrThrow({
              where: { id: approval.proposalId! },
            }),
          ).toMatchObject({ status: terminalStatus });
          expect(model.requests).toHaveLength(1);
          expect(afterUsage).toEqual(usage);
          expect(afterLedger).toEqual(ledger);
          expect(
            await handles.prisma.budgetReservation.findMany({
              where: { projectId: project.id },
              orderBy: { id: "asc" },
            }),
          ).toEqual(reservations);
          const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
          expect(run.status).toBe("waiting_budget");
          expect(run.checkpoint).toEqual(paused.checkpoint);
        }
        model.assertComplete();
      } finally {
        try {
          await stop?.();
        } finally {
          await model.close();
          await db.prisma.$disconnect();
          await db.pool.end();
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    },
    90_000,
  );
});

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
