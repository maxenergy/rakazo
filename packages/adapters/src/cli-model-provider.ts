import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Api,
  AssistantMessage,
  Model,
  MutableModels,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import { getLogger } from "@rakazo/logging";
import type { CliModelProvider } from "./cli-model-process.js";
import {
  CLI_MODEL_PROVIDERS,
  CliProcessError,
  classifyCliFailure,
  isCliProfileId,
  runCliProcess,
  saveCliFailure,
} from "./cli-model-process.js";
import {
  codexResumeDelta,
  codexThreadId,
  forgetCodexThread,
  pruneCodexThreadFiles,
  rememberCodexThread,
} from "./codex-cli-sessions.js";
import { residentCodexStep } from "./codex-resident.js";

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "calls"],
  properties: {
    text: { type: "string" },
    calls: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "argumentsJson"],
        properties: { name: { type: "string" }, argumentsJson: { type: "string" } },
      },
    },
  },
};

type CliReply = { text: string; calls: { id?: string; name: string; argumentsJson: string }[] };

/**
 * A CLI answers only after the whole turn, so the streaming time-to-first-token
 * budget would cut off long turns. Give each CLI turn the process default instead.
 */
const CLI_INFERENCE_TIMEOUT_MS = 10 * 60_000;
const CLI_INFERENCE_ATTEMPTS = 3;
const CLI_REPLY_KEPT_CHARS = 16_000;
/** A network failure is retried after a pause for the connection to recover. */
const CLI_NETWORK_RETRY_DELAY_MS = 45_000;
/** A network outage (often a local proxy restarting) can last minutes; keep trying for about six. */
const CLI_NETWORK_ATTEMPTS = 8;

/** How many tries a CLI turn gets for a failure: a subscription limit lasts until its reset. */
export function cliRetryAttempts(reason: string) {
  if (reason === "rate_limited") return 1;
  return reason === "network" ? CLI_NETWORK_ATTEMPTS : CLI_INFERENCE_ATTEMPTS;
}

/** A coarse failure label that never carries CLI output. */
function cliFailureReason(error: unknown) {
  if (error instanceof CliProcessError) return error.reason;
  if (error instanceof CliReplyError) return error.reason;
  const text = error instanceof Error ? error.message : "";
  if (/timed out/i.test(text)) return "timeout";
  if (/size limit/i.test(text)) return "output_too_large";
  if (/^Could not start/.test(text)) return "not_installed";
  if (/failed\. Check sign-in/.test(text)) return "exit_code";
  return "invalid_response";
}

// Official `agy models` slugs. API model IDs are not interchangeable with these.
const ANTIGRAVITY_MODELS = [
  ...["3.8", "3.7", "3.6"].flatMap((version) =>
    ["high", "medium", "low"].map((effort) => ({
      id: `gemini-${version}-flash-${effort}`,
      name: `Gemini ${version} Flash (${effort[0]!.toUpperCase()}${effort.slice(1)})`,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    })),
  ),
  ...["high", "low"].map((effort) => ({
    id: `gemini-3.1-pro-${effort}`,
    name: `Gemini 3.1 Pro (${effort[0]!.toUpperCase()}${effort.slice(1)})`,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  })),
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    contextWindow: 131_072,
    maxTokens: 32_000,
  },
];

/** A CLI reply Rakazo cannot use, with a coarse reason that is safe to log. */
export class CliReplyError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "parse_error"
      | "invalid_shape"
      | "unknown_tool"
      | "bad_arguments"
      | "empty_response",
    /** The tool name a model asked for, when that was the problem. */
    readonly toolName?: string,
  ) {
    super(message);
  }
}

/**
 * Whether a quote can end the string it is in, judged by what JSON allows next:
 * a key ends before a colon, an object value before `}` or the next `"key":`, and
 * an array item before `]` or a comma.
 */
function quoteEndsString(rest: string, container: "object" | "array" | undefined, key: boolean) {
  const next = rest.trimStart();
  if (key) return next.startsWith(":");
  if (container === "object")
    return next.startsWith("}") || /^,\s*"(?:[^"\\]|\\.)*"\s*:/.test(next);
  if (container === "array") return next.startsWith("]") || next.startsWith(",");
  return !next;
}

/**
 * Escape raw control characters inside JSON strings, such as a multi-line shell
 * command, and with `quotes`, also escape a double quote that cannot end its string,
 * such as the quotes of a Python one-liner inside a shell command.
 */
function repairJsonStrings(text: string, quotes: boolean) {
  let out = "";
  let inString = false;
  let escaped = false;
  let key = false;
  let expectKey = false;
  const containers: ("object" | "array")[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (!escaped && char < " ") {
        out += char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : "";
        continue;
      }
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        if (quotes && !quoteEndsString(text.slice(index + 1), containers.at(-1), key)) {
          out += '\\"';
          continue;
        }
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      key = containers.at(-1) === "object" && expectKey;
    } else if (char === "{" || char === "[") {
      containers.push(char === "{" ? "object" : "array");
      expectKey = char === "{";
    } else if (char === "}" || char === "]") containers.pop();
    else if (char === ":") expectKey = false;
    else if (char === ",") expectKey = containers.at(-1) === "object";
    out += char;
  }
  return out;
}

function parseRepairedArguments(text: string, quotes: boolean) {
  // Keep valid escapes, read left to right in pairs; double any other backslash.
  return JSON.parse(
    repairJsonStrings(text, quotes).replace(
      /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])|\\/g,
      (matchedEscape, valid) => (valid ? matchedEscape : "\\\\"),
    ),
  );
}

/**
 * Tool arguments from a CLI model, repaired for common slips: a backslash escape
 * JSON does not allow (often from shell or regex text), raw newlines or tabs inside
 * a string, unescaped quotes inside a string, and arguments encoded twice so they
 * parse to a string instead of an object.
 */
export function parseToolArguments(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = parseRepairedArguments(text, false);
    } catch {
      try {
        value = parseRepairedArguments(text, true);
      } catch {
        throw new CliReplyError("Invalid CLI model response.", "bad_arguments");
      }
    }
  }
  if (typeof value === "string") value = parseJson(value, "bad_arguments");
  return value;
}

function parseJson(text: string, reason: CliReplyError["reason"]): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliReplyError("Invalid CLI model response.", reason);
  }
}

export function parseCliReply(text: string, tools: ReadonlySet<string>): CliReply {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```$/, "");
  const reply = parseJson(stripped, "parse_error");
  if (!reply || typeof reply !== "object")
    throw new CliReplyError("Invalid CLI model response.", "invalid_shape");
  const value = reply as Partial<CliReply>;
  if (typeof value.text !== "string" || !Array.isArray(value.calls) || value.calls.length > 16)
    throw new CliReplyError("Invalid CLI model response.", "invalid_shape");
  for (const call of value.calls) {
    if (!call || typeof call.name !== "string" || typeof call.argumentsJson !== "string")
      throw new CliReplyError("Invalid CLI model response.", "invalid_shape");
    // Models trained on function calling sometimes prefix the namespace.
    const name = call.name.replace(/^functions\./, "");
    if (!tools.has(name))
      throw new CliReplyError(
        "CLI requested an unavailable tool.",
        "unknown_tool",
        name.slice(0, 80),
      );
    call.name = name;
    const args = parseToolArguments(call.argumentsJson);
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new CliReplyError("Invalid CLI tool arguments.", "bad_arguments");
    // Store the repaired form so the tool call below parses the same arguments.
    call.argumentsJson = JSON.stringify(args);
  }
  // A valid empty reply is a silent completion, not a CLI/auth failure.
  // The shared runtime decides whether the run still needs a final answer.
  return value as CliReply;
}

export function cliResponseText(provider: CliModelProvider, output: string): string {
  if (provider === "codex-cli") {
    let text = "";
    for (const line of output.split("\n").filter(Boolean)) {
      const event = parseJson(line, "parse_error") as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (event.type === "error" || event.type === "turn.failed")
        throw new CliProcessError(
          "Codex request failed. Check sign-in and subscription limits.",
          classifyCliFailure(line),
        );
      if (event.type === "item.completed" && event.item?.type === "agent_message")
        text = event.item.text ?? "";
    }
    if (!text) throw new CliReplyError("Codex returned no model response.", "empty_response");
    return text;
  }
  const result = JSON.parse(output);
  if (provider === "antigravity-cli" && result.status !== "SUCCESS")
    throw new Error("Antigravity request failed. Check sign-in and subscription limits.");
  if (result.is_error || result.error)
    throw new Error("CLI request failed. Check sign-in and subscription limits.");
  if ((provider === "claude-code" || provider === "antigravity-cli") && result.structured_output)
    return JSON.stringify(result.structured_output);
  const text =
    provider === "antigravity-cli"
      ? result.response
      : provider === "grok-cli"
        ? result.text
        : result.result;
  if (typeof text !== "string") throw new Error("CLI returned no model response.");
  return text;
}

// A CLI reports no token usage, so nothing upstream trims a long run's context.
// Keep the serialized conversation inside the model window here instead.
// Conservative for mixed text: CJK often costs about one token per character.
const CLI_CHARS_PER_TOKEN = 1.5;
const CLI_CONTEXT_SHARE = 0.5;
/**
 * A CLI can allow less context than the model's catalog window: Claude Code on a
 * subscription refuses prompts above its default window before calling the API.
 */
const CLI_CONTEXT_WINDOW_CAP: Partial<Record<CliModelProvider, number>> = {
  "claude-code": 200_000,
};
/**
 * Every step of a CLI turn starts a fresh process that resends the whole prompt, and a
 * subscription plan counts each resend in full. Keep the prompt well below even a large
 * model window so a long turn does not drain the plan; older context is condensed instead.
 */
const CLI_USAGE_WINDOW = 100_000;

/**
 * Codex runs a whole turn in one process and calls Rakazo's tools over a local MCP bridge.
 * Set RAKAZO_CLI_RESIDENT_TURNS=0 to go back to one CLI process per model step.
 */
function residentTurnsEnabled() {
  return process.env.RAKAZO_CLI_RESIDENT_TURNS !== "0";
}

function cliContextWindow(provider: CliModelProvider, catalogWindow: number | undefined) {
  const cap = Math.min(CLI_CONTEXT_WINDOW_CAP[provider] ?? CLI_USAGE_WINDOW, CLI_USAGE_WINDOW);
  return catalogWindow ? Math.min(cap, catalogWindow) : cap;
}
const CLI_RECENT_MESSAGES = 12;
const CLI_OLD_TEXT_LIMIT = 2_000;

type TranscriptMessage = TranscriptContext["messages"][number];

function messageSize(message: TranscriptMessage) {
  return JSON.stringify(message).length;
}

/** Shorten long text in an older message, keeping its start. */
function shortenOldMessage(message: TranscriptMessage): TranscriptMessage {
  if (message.role === "system" || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type === "toolCall") {
      // A whole file or script passed to a tool earlier is not needed again verbatim.
      const size = JSON.stringify(part.arguments ?? {}).length;
      if (size <= CLI_OLD_TEXT_LIMIT) return part;
      changed = true;
      return { ...part, arguments: { omitted: `${size} characters of arguments omitted` } };
    }
    if (part.type !== "text" || part.text.length <= CLI_OLD_TEXT_LIMIT) return part;
    changed = true;
    const omitted = part.text.length - CLI_OLD_TEXT_LIMIT;
    return {
      ...part,
      text: `${part.text.slice(0, CLI_OLD_TEXT_LIMIT)}\n[${omitted} more characters omitted]`,
    };
  });
  return changed ? ({ ...message, content } as TranscriptMessage) : message;
}

/** Keep the start and end of each oversized text part, which hold a log's command and result. */
function trimLatestMessage(message: TranscriptMessage, limit: number): TranscriptMessage {
  if (message.role === "system" || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "text" || part.text.length <= limit) return part;
    changed = true;
    const half = Math.floor(limit / 2);
    const omitted = part.text.length - 2 * half;
    return {
      ...part,
      text: `${part.text.slice(0, half)}\n[${omitted} characters omitted to fit the model context]\n${part.text.slice(-half)}`,
    };
  });
  return changed ? ({ ...message, content } as TranscriptMessage) : message;
}

/**
 * Fit the conversation into a character budget: shorten text in older messages,
 * then drop the oldest steps after the first user message, marking the gap.
 * System messages are always kept whole; the most recent messages are trimmed only when
 * they alone overflow the budget.
 */
export function boundCliMessages(
  messages: readonly TranscriptMessage[],
  budgetChars: number,
): TranscriptMessage[] {
  const total = (list: readonly TranscriptMessage[]) =>
    list.reduce((sum, message) => sum + messageSize(message), 0);
  if (total(messages) <= budgetChars) return [...messages];
  const recentFrom = Math.max(0, messages.length - CLI_RECENT_MESSAGES);
  const shortened = messages.map((message, index) =>
    index < recentFrom ? shortenOldMessage(message) : message,
  );
  if (total(shortened) <= budgetChars) return shortened;
  const firstUser = shortened.findIndex((message) => message.role === "user");
  const keepHead = firstUser < 0 ? 0 : firstUser + 1;
  let size = total(shortened);
  let dropped = 0;
  const kept: TranscriptMessage[] = [];
  for (let index = 0; index < shortened.length; index += 1) {
    const message = shortened[index]!;
    const droppable =
      index >= keepHead && index < recentFrom && message.role !== "system" && size > budgetChars;
    if (droppable) {
      size -= messageSize(message);
      dropped += 1;
      continue;
    }
    kept.push(message);
  }
  // Recent steps alone can still overflow; shorten all but the latest two.
  if (size > budgetChars) {
    for (let index = 0; index < kept.length - 2; index += 1) {
      kept[index] = shortenOldMessage(kept[index]!);
    }
    // A single huge tool result (a full diff or CI log) can overflow on its own, and
    // the CLI then rejects the whole prompt. Keep its start and end within budget.
    const latest = kept.slice(-2);
    const others = total(kept) - total(latest);
    const room = Math.max(CLI_OLD_TEXT_LIMIT, Math.floor((budgetChars - others) / 2));
    for (let index = Math.max(0, kept.length - 2); index < kept.length; index += 1) {
      kept[index] = trimLatestMessage(kept[index]!, room);
    }
  }
  if (dropped === 0) return kept;
  const marker = {
    role: "user",
    content: `[${dropped} earlier steps were omitted to fit the model context. Re-check current state with tools if you need it.]`,
    timestamp: Date.now(),
  } as TranscriptMessage;
  kept.splice(Math.min(keepHead, kept.length), 0, marker);
  return kept;
}

type SystemTranscriptMessage = Extract<TranscriptMessage, { role: "system" }>;

/**
 * Replay every system message into one leading message with the current
 * instructions, sections and tools. A long run adds a system message each time its
 * sections or tools change, each carrying full tool definitions; a CLI prompt
 * serializes the whole transcript, so those copies alone can exceed the CLI's limit.
 */
export function collapseSystemMessages(
  messages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const system = messages.filter(
    (message): message is SystemTranscriptMessage => message.role === "system",
  );
  if (system.length <= 1) return [...messages];
  const contents: string[] = [];
  let sections: Record<string, string | null> | undefined;
  const tools = new Map<string, NonNullable<SystemTranscriptMessage["toolsAdded"]>[number]>();
  for (const message of system) {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text).join("\n");
    if (text && !contents.includes(text)) contents.push(text);
    if (message.sections) {
      sections = { ...sections };
      for (const [name, value] of Object.entries(message.sections)) {
        if (value === null) delete sections[name];
        else sections[name] = value;
      }
    }
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  const merged: SystemTranscriptMessage = {
    role: "system",
    content: contents.join("\n\n"),
    ...(sections ? { sections } : {}),
    ...(tools.size ? { toolsAdded: [...tools.values()] } : {}),
    timestamp: system[0]!.timestamp,
  };
  return [merged, ...messages.filter((message) => message.role !== "system")];
}

/**
 * Drop the fields a provider never sends to a model. A tool result's details can
 * hold a whole file or history payload for Rakazo's own use, and a CLI prompt
 * serializes every field, so one result once came to 6.4 million characters.
 */
export function modelVisibleMessage(message: TranscriptMessage): TranscriptMessage {
  if (message.role === "toolResult") {
    const { details: _details, usage: _usage, ...visible } = message;
    return visible as TranscriptMessage;
  }
  if (message.role === "assistant") {
    const { usage: _usage, ...visible } = message;
    return visible as TranscriptMessage;
  }
  return message;
}

/** Size of each part of an oversized conversation, without any of its content. */
function conversationSizes(messages: readonly TranscriptMessage[]) {
  const sizes: Record<string, number> = {};
  let largest = 0;
  for (const message of messages) {
    const size = messageSize(message);
    sizes[`cli.chars.${message.role}`] = (sizes[`cli.chars.${message.role}`] ?? 0) + size;
    largest = Math.max(largest, size);
  }
  return { ...sizes, "cli.messages": messages.length, "cli.chars.largest_message": largest };
}

function cliPrompt(
  context: TranscriptContext,
  contextWindow?: number,
  /** Fraction of the usual context budget, lowered when a retry follows a failure. */
  budgetScale = 1,
  /** The model calls tools itself through Rakazo's MCP bridge instead of returning JSON. */
  bridged = false,
): { prompt: string; tools: Set<string> } {
  const tools = new Set<string>();
  for (const message of context.messages) {
    if (message.role === "system") {
      for (const tool of message.toolsRemoved || []) tools.delete(tool.name);
      for (const tool of message.toolsAdded || []) tools.add(tool.name);
    }
    if (
      message.role !== "system" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image")
    ) {
      throw new Error("This CLI connection accepts text. Choose a vision connection for images.");
    }
  }
  const visible = collapseSystemMessages(context.messages.map(modelVisibleMessage));
  // Bridged tools are listed by the MCP server; repeating their schemas costs tokens.
  const collapsed = bridged
    ? visible.map((message) => {
        if (message.role !== "system") return message;
        const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
        return rest as TranscriptMessage;
      })
    : visible;
  const budgetChars = contextWindow
    ? Math.floor(contextWindow * CLI_CHARS_PER_TOKEN * CLI_CONTEXT_SHARE * budgetScale)
    : undefined;
  const conversation = budgetChars ? boundCliMessages(collapsed, budgetChars) : collapsed;
  const conversationText = JSON.stringify(conversation);
  if (budgetChars && conversationText.length > budgetChars * 2) {
    getLogger().warn("cli.prompt_oversized", {
      "cli.chars.total": conversationText.length,
      "cli.chars.budget": budgetChars,
      ...conversationSizes(conversation),
    });
  }
  if (bridged)
    return {
      tools,
      prompt: `You are the model for Rakazo. Follow the system messages in the supplied conversation.
Act only through the tools of the "rakazo" MCP server. Rakazo runs them on its side, and their descriptions and results say what they can do, including writing files and running commands. Do not use the CLI's own tools, files, shell or other MCP servers. The CLI's own sandbox and approval settings only restrict this CLI process and do not describe your environment.
When you are done, reply with your final message to the conversation as plain text.
Conversation:
${conversationText}`,
    };
  return {
    tools,
    prompt: `You are the model for Rakazo. Follow the system messages in the supplied conversation.\nDo not use the CLI's own tools, files, shell, extensions, or MCP servers. Rakazo executes tools separately. If you call a tool directly, the CLI answers "No such tool available"; that does not mean the tool is missing, so request it in calls instead.\nThe CLI's own sandbox, approval, and escalation settings (for example a read-only sandbox) only restrict this CLI process. They do not describe your environment: the tools in the conversation run on Rakazo's side, and their own descriptions and results say what they can do, including writing files and running commands.\nTo request a tool defined in the conversation, return its name and JSON-encoded object arguments in calls. argumentsJson must parse as JSON: escape every double quote and backslash inside its strings. For a long or heavily quoted command, write the script to a file first, then run the file. Return user-visible text in text. After tool results, continue the conversation.\nReturn only one JSON object matching this schema: ${JSON.stringify(RESPONSE_SCHEMA)}\nConversation:\n${conversationText}`,
  };
}

/** A resumed Codex thread already holds the instructions and earlier messages. */
function cliResumePrompt(messages: TranscriptMessage[], updated: TranscriptMessage[]): string {
  const added = JSON.stringify(collapseSystemMessages(messages.map(modelVisibleMessage)));
  const revised = updated.length
    ? `Earlier tool results, updated since you saw them (they replace the earlier versions):\n${JSON.stringify(updated.map(modelVisibleMessage))}\n`
    : "";
  return `${revised}New conversation messages since your last reply:\n${added}\nContinue the conversation. Return only one JSON object matching the schema.`;
}

export function cliInferenceArgs(
  provider: CliModelProvider,
  modelId: string,
  schemaPath: string,
  /** Codex only: keep the thread so a later step can resume it, or resume this thread. */
  codexThread?: { persist: true } | { resume: string },
  /** Codex only: run the whole turn, calling Rakazo's tools through this MCP bridge. */
  bridge?: { url: string; tokenEnv: string },
): string[] {
  if (provider === "codex-cli")
    return [
      "exec",
      ...(codexThread && "resume" in codexThread ? ["resume"] : []),
      "--json",
      ...(codexThread ? [] : ["--ephemeral"]),
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      // `exec resume` takes no --sandbox or --color; the config key works for both.
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'model_provider="openai"',
      "-c",
      "features.shell_tool=false",
      "-c",
      'web_search="disabled"',
      "-c",
      "mcp_servers={}",
      ...(bridge
        ? [
            "-c",
            'approval_policy="never"',
            "-c",
            `mcp_servers.rakazo.url=${JSON.stringify(bridge.url)}`,
            "-c",
            `mcp_servers.rakazo.bearer_token_env_var=${JSON.stringify(bridge.tokenEnv)}`,
            "-c",
            'mcp_servers.rakazo.default_tools_approval_mode="approve"',
            "-c",
            "mcp_servers.rakazo.tool_timeout_sec=14400",
          ]
        : []),
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "skills.include_instructions=false",
      "-c",
      "skills.bundled.enabled=false",
      "-c",
      "include_environment_context=false",
      ...[
        "shell_tool",
        "unified_exec",
        "apps",
        "plugins",
        "browser_use",
        "computer_use",
        "code_mode",
        "code_mode_host",
        "multi_agent",
        "memories",
        "hooks",
        "image_generation",
        "view_image",
        "sleep_tool",
        "goals",
        "skill_search",
      ]
        // Codex routes MCP tool calls through the code-mode host and fails every call
        // when it is disabled; code mode itself stays off above.
        .filter((feature) => !(bridge && feature === "code_mode_host"))
        .flatMap((feature) => ["--disable", feature]),
      "--model",
      modelId,
      ...(bridge ? [] : ["--output-schema", schemaPath]),
      ...(codexThread && "resume" in codexThread ? [codexThread.resume] : []),
      "-",
    ];
  if (provider === "claude-code")
    return [
      "--print",
      "--output-format",
      "json",
      "--model",
      modelId,
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-session-persistence",
      "--settings",
      '{"disableAllHooks":true}',
      "--setting-sources",
      "",
      "--json-schema",
      JSON.stringify(RESPONSE_SCHEMA),
    ];
  if (provider === "grok-cli")
    return [
      "--no-auto-update",
      "--prompt-file",
      join(dirname(schemaPath), "prompt.txt"),
      "--output-format",
      "json",
      "--model",
      modelId,
      "--no-subagents",
      "--no-memory",
      "--no-plan",
      "--disable-web-search",
      "--max-turns",
      "1",
      "--tools",
      "rakazo_no_builtin_tools",
      "--permission-mode",
      "dontAsk",
      "--disallowed-tools",
      "read_file,search_replace,write_file,apply_patch,list_dir,grep,glob,run_terminal_command,web_search,web_fetch,todo_write,spawn_subagent,memory_search,memory_write,search_tool,use_tool,generate_image,view_image,computer_use",
      ...[
        "Bash(*)",
        "Edit(*)",
        "Read(*)",
        "Grep(*)",
        "MCPTool(*)",
        "WebFetch(*)",
        "WebSearch(*)",
      ].flatMap((rule) => ["--deny", rule]),
    ];
  return [
    "--print",
    "Return the requested JSON response.",
    "--output-format",
    "json",
    "--model",
    modelId,
    "--json-schema",
    schemaPath,
    "--disable-slash-commands",
    "--print-timeout",
    "10m",
  ];
}

function streamCliModel(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  void (async () => {
    let directory: string | undefined;
    try {
      if (!isCliProfileId(options?.apiKey))
        throw new Error("Sign in to this CLI connection first.");
      options.signal?.throwIfAborted();
      const { tools } = cliPrompt(context, model.contextWindow);
      stream.push({ type: "start", partial: message });
      directory = await mkdtemp(join(tmpdir(), "rakazo-cli-request-"));
      const schemaPath = join(directory, "response.json");
      await writeFile(schemaPath, JSON.stringify(RESPONSE_SCHEMA), { mode: 0o600 });
      const provider = model.provider as CliModelProvider;
      let reply: CliReply | undefined;
      let budgetScale = 1;
      const contextWindow = cliContextWindow(provider, model.contextWindow);
      const profileId = options.apiKey;
      const sessionId = provider === "codex-cli" ? options.sessionId : undefined;
      if (sessionId) void pruneCodexThreadFiles(profileId).catch(() => undefined);
      if (sessionId && residentTurnsEnabled()) {
        try {
          const step = await residentCodexStep({
            profileId,
            sessionId,
            messages: context.messages,
            startPrompt: () => cliPrompt(context, contextWindow, 1, true).prompt,
            args: (url, tokenEnv) =>
              cliInferenceArgs(provider, model.id, schemaPath, undefined, { url, tokenEnv }),
            signal: options.signal,
          });
          if (step?.kind === "calls")
            reply = {
              text: step.narration,
              calls: step.calls.map((call) => ({
                id: call.id,
                name: call.name,
                argumentsJson: JSON.stringify(call.arguments),
              })),
            };
          else if (step) reply = { text: cliResponseText(provider, step.output), calls: [] };
        } catch (error) {
          if (options.signal?.aborted) throw error;
          const reason = cliFailureReason(error);
          getLogger().warn("cli.resident_failed", { "cli.reason": reason });
          // A subscription limit fails the step path as well; do not spend a retry on it.
          if (reason === "rate_limited") throw error;
        }
      }
      for (let attempt = 1; !reply; attempt += 1) {
        const resume = codexResumeDelta(
          profileId,
          sessionId,
          context.messages,
          (contextWindow ?? CLI_USAGE_WINDOW) * CLI_CHARS_PER_TOKEN,
        );
        const prompt = resume
          ? cliResumePrompt(resume.messages, resume.updated)
          : cliPrompt(context, contextWindow, budgetScale).prompt;
        // Subscription CLIs report no token counts, so prompt size is the only usage signal.
        getLogger().info("cli.request", {
          "cli.provider": provider,
          "cli.model": model.id,
          "cli.chars": prompt.length,
          "cli.context_window": contextWindow,
          "cli.messages": context.messages.length,
          "cli.resumed": Boolean(resume),
        });
        // Grok CLI reads the prompt from this file instead of stdin.
        await writeFile(join(directory, "prompt.txt"), prompt, { mode: 0o600 });
        let responseText = "";
        try {
          const output = await runCliProcess({
            provider,
            profileId,
            args: cliInferenceArgs(
              provider,
              model.id,
              schemaPath,
              sessionId ? (resume ? { resume: resume.threadId } : { persist: true }) : undefined,
            ),
            cwd: directory,
            input: prompt,
            signal: options.signal,
            timeoutMs: Math.max(options.timeoutMs ?? 0, CLI_INFERENCE_TIMEOUT_MS),
          });
          responseText = cliResponseText(provider, output);
          reply = parseCliReply(responseText, tools);
          const threadId = sessionId ? codexThreadId(output) : undefined;
          if (threadId)
            rememberCodexThread(profileId, sessionId, threadId, context.messages, prompt.length);
          else forgetCodexThread(profileId, sessionId);
        } catch (error) {
          // A failed step may have left the thread out of step with the conversation.
          forgetCodexThread(profileId, sessionId);
          if (options.signal?.aborted) throw error;
          getLogger().warn("cli.inference_failed", {
            "cli.provider": provider,
            "cli.attempt": attempt,
            "cli.reason": cliFailureReason(error),
            ...(error instanceof CliReplyError && error.toolName
              ? { "cli.tool": error.toolName }
              : {}),
          });
          const reason = cliFailureReason(error);
          if (error instanceof CliReplyError && responseText) {
            // Kept privately, like CLI diagnostics, so a malformed reply can be studied.
            void saveCliFailure(
              provider,
              `reply error ${reason}\n${responseText.slice(-CLI_REPLY_KEPT_CHARS)}`,
            ).catch(() => undefined);
          }
          // A subscription limit lasts until its reset; retrying now only fails again.
          if (attempt >= cliRetryAttempts(reason)) throw error;
          // A malformed reply is a sampling slip; ask again with the same context.
          if (error instanceof CliReplyError) continue;
          if (reason === "network") {
            // The prompt was fine; wait for the connection instead of shrinking it.
            await new Promise((resolve) => setTimeout(resolve, CLI_NETWORK_RETRY_DELAY_MS));
            options.signal?.throwIfAborted();
            continue;
          }
          // A retry sends a tighter context: an oversized prompt is the usual reason
          // a long run's CLI turn fails outright, and the CLI may say so.
          budgetScale = reason === "context_too_long" ? 0.3 : 0.5;
        }
      }
      if (reply.text) {
        const part = { type: "text" as const, text: "" };
        message.content.push(part);
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        part.text = reply.text;
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: reply.text, partial: message });
      }
      for (const call of reply.calls) {
        const part = {
          type: "toolCall" as const,
          id: call.id ?? randomUUID(),
          name: call.name,
          arguments: JSON.parse(call.argumentsJson),
        };
        const contentIndex = message.content.length;
        message.content.push(part);
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
      }
      message.stopReason = reply.calls.length ? "toolUse" : "stop";
      stream.push({ type: "done", reason: message.stopReason, message });
    } catch {
      // Native CLI output may contain account details or credentials. Never forward it.
      message.stopReason = options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = options?.signal?.aborted
        ? "CLI request cancelled."
        : "CLI request failed. Check sign-in, selected model, and subscription limits. No API fallback was used.";
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      // On Windows a CLI child can still hold the directory (EBUSY); a leftover temp
      // directory must not become an unhandled rejection that stops the worker.
      if (directory)
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
          (error) => getLogger().warn("cli.request_dir_cleanup_failed", error),
        );
      stream.end();
    }
  })();
  return stream;
}

/** The same provider boundary is used by web, Electron, mobile, and nested agent calls. */
export function registerCliModelProviders(models: MutableModels): MutableModels {
  for (const [provider, meta] of Object.entries(CLI_MODEL_PROVIDERS)) {
    const source = models.getProvider(meta.source)?.getModels() || [];
    const entries =
      provider === "antigravity-cli"
        ? ANTIGRAVITY_MODELS
        : provider === "grok-cli" && source[0]
          ? [{ ...source[0], id: "grok-build", name: "Grok Build" }, ...source]
          : source;
    models.setProvider(
      createProvider({
        id: provider,
        name: meta.name,
        auth: {
          apiKey: {
            name: "CLI sign-in profile",
            resolve: async ({ credential, signal }) => {
              signal.throwIfAborted();
              return isCliProfileId(credential?.key)
                ? { auth: { apiKey: credential.key }, source: "CLI sign-in profile" }
                : undefined;
            },
          },
        },
        models: entries.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          provider,
          api: "rakazo-cli",
          baseUrl: "",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
        api: { stream: streamCliModel, streamSimple: streamCliModel },
      }),
    );
  }
  return models;
}
