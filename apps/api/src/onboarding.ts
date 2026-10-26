import type { ConnectorRegistry } from "@rakazo/adapters";
import type {
  Actor,
  MessageBlock,
  OnboardingApp,
  OnboardingFocus,
  OnboardingText,
} from "@rakazo/contracts";
import { normalizeUiLocale, ONBOARDING_COPY, onboardingText } from "@rakazo/contracts";
import { featuredConnectorProvidersMatch } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
} from "@rakazo/db";
import { requireBotThread, updateBlocks } from "./bot-thread.js";

/**
 * First-run conversational onboarding, seeded deterministically into the bot's
 * thread: greeting, a focus choice, and available app cards the user authorizes
 * inline. Focus must not rename the bot. No model tokens are spent.
 */

type OnboardingDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
  connectors: ConnectorRegistry;
};

type FocusOption = {
  id: OnboardingFocus;
  letter: string;
  apps: OnboardingApp[];
};

const FOCUS_OPTIONS: FocusOption[] = [
  {
    id: "day",
    letter: "A",
    apps: ["slack", "gmail", "googlecalendar"],
  },
  {
    id: "inbox",
    letter: "B",
    apps: ["gmail", "googlecalendar", "slack"],
  },
  {
    id: "research",
    letter: "C",
    apps: ["hackernews", "notion", "googledocs"],
  },
  {
    id: "everything",
    letter: "D",
    apps: ["slack", "gmail", "googlecalendar"],
  },
];

function textBlock(reference: OnboardingText, actor: Actor): MessageBlock {
  return {
    kind: "text",
    text: onboardingText(reference, normalizeUiLocale(actor.uiLocale)),
    onboarding: reference,
  };
}

async function post(
  deps: OnboardingDeps,
  target: { spaceId: string; botId: string; threadId: string },
  blocks: MessageBlock[],
): Promise<string> {
  const committed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "bot",
      blocks,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { message, event };
  });
  await deps.events.notify(target.threadId, committed.event.seq);
  return committed.message.id;
}

/** Sentinel answerId for a focus card the user dismissed without choosing. */
export const FOCUS_DISMISSED_ANSWER_ID = "_dismissed";

export async function startOnboarding(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { thread } = await requireBotThread(deps, actor, botId);
  const existing = await deps.prisma.message.count({ where: { threadId: thread.id } });
  if (existing > 0) return;
  // Fresh chats start empty (same as web). The focus card is posted later via
  // promptFocus so non-first bots can wait ~10s for free typing, or skip if the
  // user already engaged.
}

function messageHasChoice(blocks: MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "choice");
}

function messageHasPendingChoice(blocks: MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "choice" && !block.answerId);
}

export async function promptFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };
  const blocks: MessageBlock[] = [
    {
      kind: "choice",
      onboarding: "focus",
      question: ONBOARDING_COPY[normalizeUiLocale(actor.uiLocale)].question,
      options: FOCUS_OPTIONS.map(({ id, letter }) => ({
        id,
        letter,
        label: ONBOARDING_COPY[normalizeUiLocale(actor.uiLocale)].labels[id],
      })),
    },
  ];
  // Check + insert + event in one transaction so concurrent promptFocus calls
  // cannot duplicate cards, and a concurrent user send cannot publish first.
  const committed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Serialize concurrent promptFocus callers on this thread before the gate check.
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      select: { role: true, blocks: true },
      orderBy: { createdAt: "asc" },
    });
    if (recent.some((message) => message.role === "user")) return null;
    if (recent.some((message) => messageHasChoice(message.blocks as MessageBlock[]))) return null;
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "bot",
      blocks,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { message, event };
  });
  if (!committed) return;
  await deps.events.notify(target.threadId, committed.event.seq);
}

export async function dismissFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };
  const claimed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
    });
    const pending = recent.find((message) =>
      messageHasPendingChoice(message.blocks as MessageBlock[]),
    );
    if (!pending) return null;
    const blocks = (pending.blocks as MessageBlock[]).map((block) =>
      block.kind === "choice" && !block.answerId
        ? { ...block, answerId: FOCUS_DISMISSED_ANSWER_ID }
        : block,
    );
    await tx.message.update({ where: { id: pending.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId: pending.id, role: "bot", blocks },
    });
    return { messageId: pending.id, blocks, event };
  });
  if (!claimed) return;
  await deps.events.notify(target.threadId, claimed.event.seq);
}

export async function chooseFocus(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
  optionId: string,
): Promise<void> {
  const option = FOCUS_OPTIONS.find((entry) => entry.id === optionId);
  if (!option) throw new IsolationError();
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };

  const claimed = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    const recent = await tx.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
    });
    const pending = recent.find((message) =>
      messageHasPendingChoice(message.blocks as MessageBlock[]),
    );
    if (!pending) return null;
    const blocks = (pending.blocks as MessageBlock[]).map((block) =>
      block.kind === "choice" ? { ...block, answerId: option.id } : block,
    );
    await tx.message.update({ where: { id: pending.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId: pending.id, role: "bot", blocks },
    });
    return { messageId: pending.id, blocks, event };
  });
  if (!claimed) return;
  await deps.events.notify(target.threadId, claimed.event.seq);

  // Keep the name and title the user chose when creating the bot; the focus
  // step only suggests apps, it must not rename the bot.
  await post(deps, target, [textBlock({ id: "focus.ack", focus: option.id }, actor)]);

  const providers = deps.connectors.managedProviders();
  const catalog = (
    await Promise.all(
      providers.map((provider) =>
        provider
          .catalog({
            operationId: "onboarding.choose",
            traceId: "onboarding.choose",
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: bot.id,
            signal: AbortSignal.timeout(15_000),
          })
          .catch(() => []),
      ),
    )
  ).flat();
  const cards: MessageBlock[] = option.apps.flatMap((slug) => {
    const entry = catalog.find(
      (item) =>
        item.slug.toLowerCase() === slug.toLowerCase() ||
        featuredConnectorProvidersMatch(item.slug, slug),
    );
    if (!entry) return [];
    return [
      {
        kind: "app_connect" as const,
        connectorId: entry.connectorId ?? "composio",
        provider: entry.slug,
        name: entry.name,
        description: ONBOARDING_COPY[normalizeUiLocale(actor.uiLocale)].apps[slug],
        onboardingApp: slug,
        logo: entry.logo ?? null,
        status: entry.connected ? ("connected" as const) : ("pending" as const),
      },
    ];
  });
  if (!cards.length) {
    await post(deps, target, [textBlock({ id: "focus.next" }, actor)]);
    return;
  }
  const cardNames = cards
    .map((card) => (card.kind === "app_connect" ? card.name : ""))
    .filter(Boolean);
  await post(deps, target, [textBlock({ id: "apps.suggest", names: cardNames }, actor)]);
  await post(deps, target, cards);
  await post(deps, target, [textBlock({ id: "apps.ready", count: cards.length }, actor)]);
}

export async function markAppConnected(
  deps: OnboardingDeps,
  actor: Actor,
  botId: string,
  provider: string,
  connectorId = "composio",
): Promise<void> {
  const { bot, thread } = await requireBotThread(deps, actor, botId);
  const target = { spaceId: actor.spaceId, botId: bot.id, threadId: thread.id };
  const messages = await deps.prisma.message.findMany({
    where: { threadId: thread.id },
    select: { id: true, blocks: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    if (
      !blocks.some(
        (block) =>
          block.kind === "app_connect" &&
          (block.connectorId ?? "composio") === connectorId &&
          featuredConnectorProvidersMatch(block.provider, provider) &&
          block.status !== "connected",
      )
    )
      continue;
    const next = blocks.map((block) =>
      block.kind === "app_connect" &&
      (block.connectorId ?? "composio") === connectorId &&
      featuredConnectorProvidersMatch(block.provider, provider)
        ? { ...block, status: "connected" as const }
        : block,
    );
    await updateBlocks(deps, target, message.id, next);
  }
}
