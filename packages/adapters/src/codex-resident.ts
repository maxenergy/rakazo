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
      if (!line.includes('"agent_message"') && !line.includes('"turn.completed"')) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          item?: { type?: string; text?: string };
          usage?: Record<string, number>;
        };
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
    turn.bridge.resolve(id, result);
  });
  turn.waiting = [];
  return true;
}

export type ResidentStepOptions = {
  profileId: string;
  sessionId: string;
  messages: readonly TranscriptMessage[];
  /** Prompt that starts a new turn: the instructions and the bounded conversation. */
  startPrompt: () => string;
  args: (bridgeUrl: string, tokenEnv: string) => string[];
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
    const prompt = options.startPrompt();
    const started: ResidentTurn = new ResidentTurn(
      bridge,
      (signal, onOutput) =>
        runCliProcess({
          provider: "codex-cli",
          profileId: options.profileId,
          args: options.args(url, TOKEN_ENV),
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
    turn = started;
    turns.set(key, turn);
    getLogger().info("cli.resident_start", {
      "cli.chars": prompt.length,
      "cli.tools": tools.length,
    });
  }
  const outcome = await turn.next(options.signal);
  if (outcome.kind === "failed") throw outcome.error;
  return outcome;
}

/** Stop every resident turn, for shutdown and tests. */
export function stopResidentTurns() {
  for (const turn of turns.values()) turn.stop();
  turns.clear();
}
