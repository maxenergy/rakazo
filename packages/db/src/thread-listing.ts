import { ACTIVE_RUN_STATUSES, BACKGROUND_RUN_TRIGGERS, plainTextFromMarkdown } from "@rakazo/core";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];
const backgroundRunTriggers = [...BACKGROUND_RUN_TRIGGERS];
const userVisibleBotRunTriggers = ["bot_message", ...BACKGROUND_RUN_TRIGGERS];
const latestBotRunOrderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/**
 * The newest conversational/foreground run for a bot's sidebar status. Background
 * ticket runs keep working silently, so they must not make the avatar spin.
 */
export const activeRunSelection = {
  where: {
    status: { in: activeRunStatuses },
    trigger: { notIn: backgroundRunTriggers },
  },
  orderBy: { createdAt: "desc" as const },
  // A bot works one turn at a time; newer turns queue behind it.
  take: 10,
  select: { status: true },
} as const;

const ROSTER_STATUS_PRIORITY = ["waiting_budget", "waiting_takeover", "waiting_input", "running", "leased", "queued"];

/**
 * The run that best describes a bot right now: one that needs the user, then the
 * turn it is working on, before turns queued behind it. Otherwise a bot with queued
 * messages reads as waiting in line while it is busy working.
 */
export function rosterActiveRun<T extends { status: string }>(runs: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const run of runs) {
    const rank = ROSTER_STATUS_PRIORITY.indexOf(run.status);
    if (rank < 0) continue;
    if (!best || rank < ROSTER_STATUS_PRIORITY.indexOf(best.status)) best = run;
  }
  return best ?? runs[0];
}

/** Latest user-visible run for a bot roster error signal; later success clears an older failure. */
export const latestBotRunSelection = {
  where: { trigger: { notIn: userVisibleBotRunTriggers } },
  orderBy: latestBotRunOrderBy,
  take: 1,
  select: { id: true, status: true },
} as const;

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return plainTextFromMarkdown((block as { text: string }).text);
    }
  }
  return "";
}
