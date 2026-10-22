import type { TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./cli-model-process.js", () => ({ runCliProcess: vi.fn() }));

import { runCliProcess } from "./cli-model-process.js";
import { residentCodexStep, stopResidentTurns, transcriptTools } from "./codex-resident.js";

type Message = TranscriptContext["messages"][number];

const tool = { name: "shell", description: "Run", parameters: { type: "object", properties: {} } };
const system = {
  role: "system",
  content: "Be useful",
  toolsAdded: [tool],
  timestamp: 0,
} as unknown as Message;
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as Message;

afterEach(() => {
  stopResidentTurns();
  vi.mocked(runCliProcess).mockReset();
});

/** A stand-in Codex process: calls the bridged tool once, then answers with its result. */
function fakeCodex() {
  vi.mocked(runCliProcess).mockImplementation(async (options) => {
    const args = options.args;
    const url = JSON.parse(
      args.find((arg) => arg.startsWith("mcp_servers.rakazo.url="))!.split("=")[1]!,
    );
    const token = options.env!.RAKAZO_TOOL_TOKEN!;
    options.onOutput?.(
      '{"type":"thread.started","thread_id":"codex-thread-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Checking."}}\n',
      () => undefined,
      () => undefined,
      true,
    );
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "shell", arguments: { command: "ls" } },
      }),
    });
    const result = (await response.json()) as { result: { content: { text: string }[] } };
    const text = result.result.content.map((part) => part.text).join(" | ");
    return `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `Saw: ${text}` } })}\n`;
  });
}

const step = (messages: Message[]) =>
  residentCodexStep({
    profileId: "profile",
    sessionId: "thread:bot",
    messages,
    startPrompt: () => "start",
    resumePrompt: (added) => `resume ${added.length}`,
    args: (url, tokenEnv, thread) => [
      "-c",
      `mcp_servers.rakazo.url=${JSON.stringify(url)}`,
      "-c",
      `mcp_servers.rakazo.bearer_token_env_var=${JSON.stringify(tokenEnv)}`,
      "resume" in thread ? `resume=${thread.resume}` : "persist",
    ],
  });

describe("resident Codex turns", () => {
  it("reads the current tool set from system messages", () => {
    const removed = {
      role: "system",
      content: "",
      toolsRemoved: [{ name: "shell" }],
      timestamp: 0,
    };
    expect(transcriptTools([system])).toEqual([tool]);
    expect(transcriptTools([system, removed as unknown as Message])).toEqual([]);
  });

  it("hands Codex's tool call to Rakazo and returns the answer to the same process", async () => {
    fakeCodex();
    const first = await step([system, user("List files")]);
    expect(first).toMatchObject({ kind: "calls", narration: "Checking." });
    const call = first?.kind === "calls" ? first.calls[0] : undefined;
    expect(call).toMatchObject({ name: "shell", arguments: { command: "ls" } });

    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: call!.id, name: "shell", arguments: { command: "ls" } }],
      timestamp: 0,
    } as unknown as Message;
    const result = {
      role: "toolResult",
      toolCallId: call!.id,
      toolName: "shell",
      content: [{ type: "text", text: "a.txt" }],
      isError: false,
      timestamp: 0,
    } as unknown as Message;
    const second = await step([system, user("List files"), assistant, result, user("Also hurry")]);
    expect(second?.kind).toBe("done");
    const output = second?.kind === "done" ? second.output : "";
    expect(output).toContain("Saw: a.txt");
    expect(output).toContain("Also hurry");
    expect(runCliProcess).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCliProcess).mock.calls[0]![0].args).toContain("persist");

    // The bot's next turn continues the same Codex thread with only the new messages.
    const finalReply = {
      role: "assistant",
      content: [{ type: "text", text: "Saw: a.txt" }],
      timestamp: 0,
    } as unknown as Message;
    await step([
      system,
      user("List files"),
      assistant,
      result,
      user("Also hurry"),
      finalReply,
      user("Next task"),
    ]);
    const next = vi.mocked(runCliProcess).mock.calls[1]![0];
    expect(next.args).toContain("resume=codex-thread-1");
    expect(next.input).toBe("resume 1");
  });

  it("starts over when the conversation no longer answers the waiting call", async () => {
    fakeCodex();
    await step([system, user("List files")]);
    await expect(step([system, user("Something else")])).resolves.toMatchObject({ kind: "calls" });
    expect(runCliProcess).toHaveBeenCalledTimes(2);
  });

  it("leaves a conversation without tools to the step-by-step path", async () => {
    await expect(step([user("Hi")])).resolves.toBeUndefined();
    expect(runCliProcess).not.toHaveBeenCalled();
  });
});
