import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { getLogger } from "@rakazo/logging";
import { cliProfileDirectory } from "./cli-model-process.js";

type TranscriptMessage = TranscriptContext["messages"][number];

/**
 * Each step of a CLI turn starts a new `codex exec` process. A new process is a new
 * Codex thread, and Codex keys its prompt cache by thread, so every step used to pay
 * for the whole conversation again. Resuming the thread a step left behind sends only
 * the messages added since, and the provider serves the earlier ones from its cache.
 */
type CodexThread = {
  threadId: string;
  /** Messages of the Rakazo conversation already inside the thread. */
  sent: number;
  /** Hash of each of those messages; a changed history (condensed, edited) starts a new thread. */
  sentHashes: string[];
  /** Characters sent into the thread so far; a thread is retired before it grows unbounded. */
  chars: number;
};

const threads = new Map<string, CodexThread>();
const THREAD_FILE_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Only what the model reads counts: the runtime fills in usage, details and similar
 * bookkeeping on earlier messages after the step that sent them.
 */
function hashMessages(messages: readonly TranscriptMessage[]): string[] {
  return messages.map((message) => {
    const { role, content } = message as { role: string; content: unknown };
    const toolCallId = (message as { toolCallId?: string }).toolCallId;
    return createHash("sha256")
      .update(JSON.stringify([role, toolCallId ?? null, content]))
      .digest("hex");
  });
}

function threadKey(profileId: string, sessionId: string) {
  return `${profileId}:${sessionId}`;
}

/**
 * The messages to send when the conversation still extends the thread: everything after
 * what the thread holds, skipping the assistant reply Codex itself produced last step.
 */
export function codexResumeDelta(
  profileId: string,
  sessionId: string | undefined,
  messages: readonly TranscriptMessage[],
  maxChars: number,
): { threadId: string; messages: TranscriptMessage[]; updated: TranscriptMessage[] } | undefined {
  if (!sessionId) return undefined;
  const thread = threads.get(threadKey(profileId, sessionId));
  if (!thread) return undefined;
  const current = hashMessages(messages.slice(0, thread.sent));
  const changedIndexes = thread.sentHashes.flatMap((hash, index) =>
    current[index] === hash ? [] : [index],
  );
  // The runtime rewrites recent tool results (shortened output, finished shells) after
  // the thread saw them; resend those. Any other edit means a different history.
  const changed = changedIndexes.find((index) => messages[index]?.role !== "toolResult") ?? -1;
  const reason =
    thread.chars >= maxChars
      ? "thread_full"
      : messages[thread.sent]?.role !== "assistant" || messages.length <= thread.sent + 1
        ? "not_extended"
        : changed >= 0
          ? "history_changed"
          : undefined;
  if (reason) {
    getLogger().info("cli.resume_skipped", {
      "cli.reason": reason,
      ...(changed >= 0
        ? {
            "cli.changed_index": changed,
            "cli.changed_from_end": thread.sent - changed,
            "cli.changed_role": messages[changed]?.role ?? "missing",
            "cli.messages_before": thread.sent,
            "cli.messages_now": messages.length,
          }
        : {}),
    });
    return undefined;
  }
  return {
    threadId: thread.threadId,
    messages: messages.slice(thread.sent + 1),
    updated: changedIndexes.map((index) => messages[index]!),
  };
}

/** Remember the thread a step used, so the next step of the conversation resumes it. */
export function rememberCodexThread(
  profileId: string,
  sessionId: string | undefined,
  threadId: string,
  messages: readonly TranscriptMessage[],
  sentChars: number,
) {
  if (!sessionId) return;
  const key = threadKey(profileId, sessionId);
  const previous = threads.get(key);
  threads.set(key, {
    threadId,
    sent: messages.length,
    sentHashes: hashMessages(messages),
    chars: (previous?.threadId === threadId ? previous.chars : 0) + sentChars,
  });
}

export function forgetCodexThread(profileId: string, sessionId: string | undefined) {
  if (sessionId) threads.delete(threadKey(profileId, sessionId));
}

/** Thread id from `codex exec --json` output, if Codex reported one. */
export function codexThreadId(output: string): string | undefined {
  for (const line of output.split("\n")) {
    if (!line.includes('"thread.started"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string };
      if (event.type === "thread.started" && event.thread_id) return event.thread_id;
    } catch {
      // Not a JSON event line.
    }
  }
  return undefined;
}

/** Saved threads are only needed while a turn runs; drop files older than a day. */
export async function pruneCodexThreadFiles(profileId: string, now = Date.now()) {
  const root = join(cliProfileDirectory(profileId), ".codex", "sessions");
  const entries = await readdir(root, { recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const file = join(root, entry);
    const info = await stat(file).catch(() => undefined);
    if (info && now - info.mtimeMs > THREAD_FILE_MAX_AGE_MS)
      await rm(file, { force: true }).catch(() => undefined);
  }
}
