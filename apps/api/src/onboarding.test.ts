import type * as db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { chooseFocus, markAppConnected, promptFocus } from "./onboarding.js";

const posted = vi.hoisted(() => [] as Array<{ blocks: unknown[] }>);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    posted.push(input);
    return { id: "posted" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));
function fixture(catalog: unknown[]) {
  posted.length = 0;
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => [{ id: "choice", blocks: [{ kind: "choice", answerId: null }] }]),
      update: vi.fn(),
    },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "thread" } })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
    connectors: { managedProviders: () => [{ catalog: async () => catalog }] },
  } as unknown as Parameters<typeof chooseFocus>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx };
}
describe("onboarding connection suggestions", () => {
  it("persists a translated focus card with a locale-independent reference", async () => {
    const { deps, actor, tx } = fixture([]);
    tx.message.findMany.mockResolvedValue([]);
    await promptFocus(deps, { ...actor, uiLocale: "zh-CN" }, "bot");
    expect(posted[0]?.blocks[0]).toMatchObject({
      kind: "choice",
      onboarding: "focus",
      question: "你想让我先做什么？",
      options: expect.arrayContaining([expect.objectContaining({ id: "day", label: "日常工作" })]),
    });
  });
  it("uses Chinese copy for follow-ups, application descriptions, and the no-catalog fallback", async () => {
    const { deps, actor } = fixture([
      { connectorId: "pipedream", slug: "slack", name: "Slack", connected: false, logo: null },
    ]);
    await chooseFocus(deps, { ...actor, uiLocale: "zh-CN" }, "bot", "day");
    expect(posted.flatMap((message) => message.blocks)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "text",
          text: "明白了，先处理Slack、日历和邮件。我会先检查已有的连接，避免让你重复设置。",
          onboarding: { id: "focus.ack", focus: "day" },
        }),
        expect.objectContaining({
          kind: "app_connect",
          description: "搜索、阅读和发送消息。",
          onboardingApp: "slack",
        }),
        expect.objectContaining({
          kind: "text",
          text: "连接这 1 个应用后，我就开始整理相关信息。",
        }),
      ]),
    );
    const empty = fixture([]);
    await chooseFocus(empty.deps, { ...empty.actor, uiLocale: "zh-CN" }, "bot", "research");
    expect(posted.at(-1)?.blocks).toEqual([
      expect.objectContaining({ text: "你想先从哪项任务开始？", onboarding: { id: "focus.next" } }),
    ]);
  });
  it("does not invent authorization cards when no connector has an app catalog", async () => {
    const { deps, actor } = fixture([]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(posted.flatMap((message) => message.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: "app_connect" }),
    );
    expect(posted.length).toBeGreaterThan(0);
  });
  it("uses the available connector and omits unavailable apps", async () => {
    const { deps, actor } = fixture([
      { connectorId: "pipedream", slug: "slack", name: "Slack", connected: false, logo: null },
    ]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(
      posted
        .flatMap((message) => message.blocks)
        .filter((block) => (block as { kind: string }).kind === "app_connect"),
    ).toEqual([
      expect.objectContaining({ connectorId: "pipedream", provider: "slack", name: "Slack" }),
    ]);
  });
});

it("marks only the authorized connector when provider slugs collide", async () => {
  const { deps, actor, tx } = fixture([]);
  const blocks = ["composio", "pipedream"].map((connectorId) => ({
    kind: "app_connect",
    connectorId,
    provider: "slack",
    name: "Slack",
    status: "pending",
  }));
  deps.prisma.message = { findMany: vi.fn(async () => [{ id: "cards", blocks }]) } as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream");
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "cards" },
    data: { blocks: [blocks[0], { ...blocks[1], status: "connected" }] },
  });
});
