import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { getLogger } from "@rakazo/logging";
import { runCliProcess } from "./cli-model-process.js";
import type { BridgeCall, BridgeResult, BridgeTool } from "./codex-tool-bridge.js";
import { CodexToolBridge } from "./codex-tool-bridge.js";

type TranscriptMessage = TranscriptContext["messages"][number];

/** How long a turn may wait for Rakazo to answer a tool call before Codex is stopped. */
const RESIDENT_IDLE_MS = 30 * 60_000;
const RESIDENT_TIMEOUT_MS = 4 * 60 * 60_000;
const TOKEN_ENV = "RAKAZO_TOOL_TOKEN";
/**
 * A bot's Codex thread carries over from turn to turn, so a new turn sends only the new
 * messages. Past this many characters sent into it (prompts and tool results), the next
 * turn starts a fresh thread from the bounded conversation instead.
 */
const THREAD_MAX_CHARS = 400_000;

export type ResidentStep =
  | { kind: "calls"; calls: BridgeCall[]; narration: string }
  | { kind: "done"; output: string };

type Outcome = ResidentStep | { kind: "failed"; error: unknown };

/**
 * One Codex process that runs a whole Rakazo turn. Codex calls the run's tools through a
 * local MCP bridge; each call is handed back to Rakazo's own agent loop as an ordinary
 * tool call, so guards, approvals, budgets, fencing and events stay exactly as they are,
 * and the answer goes back to the same waiting Codex process. Codex keeps the turn's
 * context and cache itself, instead of Rakazo resending the conversation every step.
 */
class ResidentTurn {
  private readonly controller = new AbortController();
  private readonly finished: Promise<Outcome>;
  private narration: string[] = [];
  private lineBuffer = "";
  private idle: NodeJS.Timeout | undefined;
  /** Tool call ids Codex is waiting on, in the order they were handed to Rakazo. */
  waiting: string[] = [];
  stopped = false;
  /** The Codex thread this turn runs in, once Codex reports it. */
  threadId: string | undefined;
  /** Characters sent into the thread during this turn. */
  charsSent = 0;

  constructor(
    readonly bridge: CodexToolBridge,
    run: (signal: AbortSignal, onOutput: (text: string) => void) => Promise<string>,
    private readonly onEnd: () => void,
  ) {
    this.finished = run(this.controller.signal, (text) => this.receive(text)).then(
      (output): Outcome => ({ kind: "done", output }),
      (error): Outcome => ({ kind: "failed", error }),
    );
    void this.finished.then(() => this.stop());
  }

  async next(signal: AbortSignal | undefined): Promise<Outcome> {
    clearTimeout(this.idle);
    const aborted = new Promise<Outcome>((resolve) => {
      if (!signal) return;
      const abort = () => resolve({ kind: "failed", error: new Error("CLI request cancelled.") });
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    const calls = this.bridge
      .nextCalls()
      .then((found): Outcome => ({ kind: "calls", calls: found, narration: "" }));
    const outcome = await Promise.race([calls, this.finished, aborted]);
    if (outcome.kind === "calls") {
      outcome.narration = this.narration.splice(0).join("\n\n");
      this.waiting = outcome.calls.map((call) => call.id);
      this.idle = setTimeout(() => this.stop(), RESIDENT_IDLE_MS);
      this.idle.unref();
    } else {
      this.stop();
    }
    return outcome;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idle);
    this.controller.abort();
    this.bridge.close();
    this.onEnd();
  }

  private receive(text: string) {
    this.lineBuffer += text;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (
        !line.includes('"agent_message"') &&
        !line.includes('"turn.completed"') &&
        !line.includes('"thread.started"')
      )
        continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          thread_id?: string;
          item?: { type?: string; text?: string };
          usage?: Record<string, number>;
        };
        if (event.type === "thread.started" && event.thread_id) this.threadId = event.thread_id;
        // The subscription's real cost: Codex reports the whole turn's tokens once.
        if (event.type === "turn.completed" && event.usage)
          getLogger().info("cli.resident_usage", {
            "cli.usage.input": event.usage.input_tokens ?? 0,
            "cli.usage.cached_input": event.usage.cached_input_tokens ?? 0,
            "cli.usage.output": event.usage.output_tokens ?? 0,
          });
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          event.item.text
        )
          this.narration.push(event.item.text);
      } catch {
        // Not a complete JSON event.
      }
    }
  }
}

const turns = new Map<string, ResidentTurn>();

/**
 * The Codex thread a bot's last turn ran in. A new turn rebuilds the conversation from
 * stored messages, so it is matched by their stored ids, not by position or content.
 */
type BotThread = { threadId: string; seen: Set<string>; systemHash: string; chars: number };
const botThreads = new Map<string, BotThread>();

function storedId(message: TranscriptMessage): string | undefined {
  return (message as { rakazoMessageId?: string }).rakazoMessageId;
}

function systemText(messages: readonly TranscriptMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map(messageText)
    .join("\n\n");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The bot's own earlier replies, which the Codex thread already holds. */
function isOwnReply(message: TranscriptMessage): boolean {
  return (
    (message as { rakazoHistory?: boolean }).rakazoHistory === true &&
    messageText(message).startsWith("Assistant: ")
  );
}

/**
 * Messages a new turn must add to the bot's Codex thread: those after the newest one the
 * thread has already seen, plus the instructions when they changed. Undefined when there
 * is no usable thread, so the turn starts fresh from the bounded conversation.
 */
export function botThreadDelta(
  key: string,
  messages: readonly TranscriptMessage[],
): { threadId: string; messages: TranscriptMessage[] } | undefined {
  const thread = botThreads.get(key);
  if (!thread || thread.chars >= THREAD_MAX_CHARS) return undefined;
  let last = -1;
  messages.forEach((message, index) => {
    const id = storedId(message);
    if (id && thread.seen.has(id)) last = index;
  });
  if (last < 0) return undefined;
  const added = messages
    .slice(last + 1)
    .filter((message) => message.role !== "system" && !isOwnReply(message));
  if (added.length === 0) return undefined;
  const system = systemText(messages);
  return {
    threadId: thread.threadId,
    messages:
      hashText(system) === thread.systemHash
        ? added
        : [{ role: "system", content: system, timestamp: 0 } as TranscriptMessage, ...added],
  };
}

export function rememberBotThread(
  key: string,
  threadId: string,
  messages: readonly TranscriptMessage[],
  chars: number,
) {
  const previous = botThreads.get(key);
  const same = previous?.threadId === threadId;
  const seen = same ? previous.seen : new Set<string>();
  for (const message of messages) {
    const id = storedId(message);
    if (id) seen.add(id);
  }
  botThreads.set(key, {
    threadId,
    seen,
    systemHash: hashText(systemText(messages)),
    chars: (same ? previous.chars : 0) + chars,
  });
}

function turnKey(profileId: string, sessionId: string) {
  return `${profileId}:${sessionId}`;
}

/** Tools the conversation's system messages currently give the model. */
export function transcriptTools(messages: readonly TranscriptMessage[]): BridgeTool[] {
  const tools = new Map<string, BridgeTool>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool as BridgeTool);
  }
  return [...tools.values()];
}

function toBridgeResult(message: TranscriptMessage): BridgeResult {
  const content: BridgeResult["content"] = [];
  const parts = (message as { content?: unknown }).content;
  if (typeof parts === "string") content.push({ type: "text", text: parts });
  else if (Array.isArray(parts))
    for (const part of parts as Array<Record<string, unknown>>) {
      if (part.type === "text" && typeof part.text === "string")
        content.push({ type: "text", text: part.text });
      if (part.type === "image" && typeof part.data === "string")
        content.push({
          type: "image",
          data: part.data,
          mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png",
        });
    }
  if (content.length === 0) content.push({ type: "text", text: "(no output)" });
  return { content, isError: (message as { isError?: boolean }).isError === true };
}

function messageText(message: TranscriptMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

/**
 * Answer the tool calls a resident turn is waiting on from the conversation Rakazo now
 * holds. Messages that arrived meanwhile (steering) ride along with the last answer.
 * Returns false when the conversation no longer matches the waiting calls.
 */
function answerWaitingCalls(turn: ResidentTurn, messages: readonly TranscriptMessage[]): boolean {
  const waiting = new Set(turn.waiting);
  const callIndex = messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part.type === "toolCall" && waiting.has((part as { id: string }).id),
      ),
  );
  if (callIndex < 0) return false;
  const after = messages.slice(callIndex + 1);
  const results = new Map<string, TranscriptMessage>();
  const extra: TranscriptMessage[] = [];
  for (const message of after) {
    const id = (message as { toolCallId?: string }).toolCallId;
    if (message.role === "toolResult" && id && waiting.has(id)) results.set(id, message);
    else if (message.role === "user" || message.role === "system") extra.push(message);
    else return false;
  }
  if (results.size !== waiting.size) return false;
  const note = extra
    .map(messageText)
    .filter(Boolean)
    .map((text) => `\n\n[New message in the conversation while you worked]\n${text}`)
    .join("");
  turn.waiting.forEach((id, index) => {
    const result = toBridgeResult(results.get(id)!);
    if (note && index === turn.waiting.length - 1)
      result.content.push({ type: "text", text: note.trimStart() });
    for (const part of result.content) if (part.type === "text") turn.charsSent += part.text.length;
    turn.bridge.resolve(id, result);
  });
  turn.waiting = [];
  return true;
}

export type ResidentStepOptions = {
  profileId: string;
  sessionId: string;
  messages: readonly TranscriptMessage[];
  /** Prompt that starts a new thread: the instructions and the bounded conversation. */
  startPrompt: () => string;
  /** Prompt that continues the bot's thread with only what is new since its last turn. */
  resumePrompt: (messages: TranscriptMessage[], updated: TranscriptMessage[]) => string;
  args: (
    bridgeUrl: string,
    tokenEnv: string,
    thread: { persist: true } | { resume: string },
  ) => string[];
  signal?: AbortSignal;
};

/**
 * Advance the resident Codex turn for this conversation by one Rakazo step. Returns
 * undefined when the conversation does not continue a live turn and a new one cannot
 * be started, so the caller uses its ordinary step-by-step path.
 */
export async function residentCodexStep(
  options: ResidentStepOptions,
): Promise<ResidentStep | undefined> {
  const key = turnKey(options.profileId, options.sessionId);
  let turn = turns.get(key);
  if (turn && !turn.stopped && turn.waiting.length > 0) {
    if (!answerWaitingCalls(turn, options.messages)) {
      getLogger().info("cli.resident_restart", { "cli.reason": "conversation_changed" });
      turn.stop();
      turn = undefined;
    }
  } else if (turn) {
    turn.stop();
    turn = undefined;
  }
  if (!turn) {
    const tools = transcriptTools(options.messages);
    if (tools.length === 0) return undefined;
    const bridge = new CodexToolBridge(tools);
    const url = await bridge.start();
    const directory = await mkdtemp(join(tmpdir(), "rakazo-cli-turn-"));
    const delta = botThreadDelta(key, options.messages);
    const prompt = delta ? options.resumePrompt(delta.messages, []) : options.startPrompt();
    const thread = delta ? { resume: delta.threadId } : { persist: true as const };
    const started: ResidentTurn = new ResidentTurn(
      bridge,
      (signal, onOutput) =>
        runCliProcess({
          provider: "codex-cli",
          profileId: options.profileId,
          args: options.args(url, TOKEN_ENV, thread),
          cwd: directory,
          input: prompt,
          env: { [TOKEN_ENV]: bridge.token },
          signal,
          timeoutMs: RESIDENT_TIMEOUT_MS,
          onOutput: (text, _write, _stop, stdout) => {
            if (stdout) onOutput(text);
          },
        }).finally(() =>
          rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
            () => undefined,
          ),
        ),
      () => {
        if (turns.get(key) === started) turns.delete(key);
      },
    );
    started.charsSent = prompt.length;
    turn = started;
    turns.set(key, turn);
    getLogger().info("cli.resident_start", {
      "cli.chars": prompt.length,
      "cli.tools": tools.length,
      "cli.resumed": Boolean(delta),
    });
  }
  const active = turn;
  const outcome = await active.next(options.signal);
  if (outcome.kind === "failed") {
    botThreads.delete(key);
    throw outcome.error;
  }
  if (outcome.kind === "done") {
    // Keep the thread: the bot's next turn continues it with only the new messages.
    if (active.threadId)
      rememberBotThread(key, active.threadId, options.messages, active.charsSent);
    else botThreads.delete(key);
  }
  return outcome;
}

/** Stop every resident turn, for shutdown and tests. */
export function stopResidentTurns() {
  for (const turn of turns.values()) turn.stop();
  turns.clear();
  botThreads.clear();
}
