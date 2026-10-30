import { execFile } from "node:child_process";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliModelProvider } from "./cli-model-process.js";
import { CLI_MODEL_PROVIDERS, CliProcessError, runCliProcess } from "./cli-model-process.js";
import {
  boundCliMessages,
  cliInferenceArgs,
  cliResponseText,
  cliRetryAttempts,
  collapseSystemMessages,
  modelVisibleMessage,
  parseCliReply,
  parseToolArguments,
  registerCliModelProviders,
} from "./cli-model-provider.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  execFile: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(new Error("CLI unavailable in offline test"), "", "");
    return {} as ReturnType<typeof execFile>;
  });
});

vi.mock("./cli-model-process.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runCliProcess: vi.fn(),
  cliExecutable: () => ({ file: "mock-cli", prefix: [] }),
}));
afterEach(() => vi.resetAllMocks());

const profileId = "11111111-1111-4111-8111-111111111111";
const answer = { text: "查到了", calls: [] };
function output(
  provider: CliModelProvider,
  reply: { text: string; calls: { name: string; argumentsJson: string }[] } = answer,
) {
  if (provider === "codex-cli")
    return `${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(reply) },
    })}\n`;
  if (provider === "claude-code") return JSON.stringify({ structured_output: reply });
  return JSON.stringify({
    ...(provider === "antigravity-cli" ? { status: "SUCCESS" } : {}),
    [provider === "antigravity-cli" ? "response" : "text"]: JSON.stringify(reply),
  });
}

describe("subscription CLI provider conformance", () => {
  it.each(Object.keys(CLI_MODEL_PROVIDERS) as CliModelProvider[])(
    "runs %s with only its selected profile and backend tools",
    async (provider) => {
      vi.mocked(runCliProcess).mockResolvedValue(
        output(provider, {
          text: "",
          calls: [{ name: "lookup", argumentsJson: '{"query":"test"}' }],
        }),
      );
      const models = registerCliModelProviders(builtinModels());
      const model = models.getProvider(provider)?.getModels()[0];
      if (!model) throw new Error("Missing CLI model");
      const events = [];
      const stream = models.streamSimple(
        model,
        {
          systemPrompt: "Use only the authorized lookup tool.",
          messages: [{ role: "user", content: "Look up test", timestamp: 1 }],
          tools: [
            {
              name: "lookup",
              description: "Look up a test",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        },
        { apiKey: profileId },
      );
      for await (const event of stream) events.push(event);
      const result = await stream.result();
      expect(result.stopReason).toBe("toolUse");
      expect(result.content).toEqual([
        expect.objectContaining({ type: "toolCall", name: "lookup", arguments: { query: "test" } }),
      ]);
      expect(events[0]?.type).toBe("start");
      expect(events.at(-1)?.type).toBe("done");
      expect(runCliProcess).toHaveBeenCalledOnce();
      expect(vi.mocked(runCliProcess).mock.calls[0]?.[0]).toMatchObject({
        provider,
        profileId,
        input: expect.stringContaining("Look up test"),
      });
      expect(model.input).toEqual(["text"]);
    },
  );

  it("returns text after a backend tool result without invoking that tool in the CLI", async () => {
    vi.mocked(runCliProcess).mockResolvedValue(output("claude-code"));
    const models = registerCliModelProviders(builtinModels());
    const model = models.getProvider("claude-code")!.getModels()[0]!;
    const result = await models
      .streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "What did the lookup find?", timestamp: 1 },
            {
              role: "toolResult",
              toolCallId: "call",
              toolName: "lookup",
              content: [{ type: "text", text: "Found the test" }],
              isError: false,
              timestamp: 2,
            },
          ],
        },
        { apiKey: profileId },
      )
      .result();
    expect(result.content).toEqual([{ type: "text", text: "查到了" }]);
    expect(vi.mocked(runCliProcess).mock.calls[0]?.[0].input).toContain("Found the test");
  });

  it.each(Object.keys(CLI_MODEL_PROVIDERS) as CliModelProvider[])(
    "accepts a valid silent completion from %s",
    async (provider) => {
      vi.mocked(runCliProcess).mockResolvedValue(output(provider, { text: "", calls: [] }));
      const models = registerCliModelProviders(builtinModels());
      const model = models.getProvider(provider)!.getModels()[0]!;
      const result = await models
        .streamSimple(model, { messages: [] }, { apiKey: profileId })
        .result();
      expect(result.stopReason).toBe("stop");
      expect(result.content).toEqual([]);
      expect(result.errorMessage).toBeUndefined();
      expect(runCliProcess).toHaveBeenCalledOnce();
    },
  );

  it.each(["", " \n\t"])(
    "rejects successful Claude processes with empty stdout",
    async (stdout) => {
      vi.mocked(runCliProcess).mockResolvedValue(stdout);
      const models = registerCliModelProviders(builtinModels());
      const model = models.getProvider("claude-code")!.getModels()[0]!;
      const result = await models
        .streamSimple(model, { messages: [] }, { apiKey: profileId })
        .result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("Claude CLI failed to start");
      expect(runCliProcess).toHaveBeenCalledOnce();
    },
  );

  it("rejects an unbound profile and images before any process runs", async () => {
    const models = registerCliModelProviders(builtinModels());
    const model = models.getProvider("codex-cli")!.getModels()[0]!;
    const result = await models
      .streamSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "image", data: "fake", mimeType: "image/png" }],
              timestamp: 1,
            },
          ],
        },
        { apiKey: profileId },
      )
      .result();
    expect(result.stopReason).toBe("error");
    expect(runCliProcess).not.toHaveBeenCalled();
    const unbound = await models
      .streamSimple(model, { messages: [] }, { apiKey: "not-a-profile" })
      .result();
    expect(unbound.stopReason).toBe("error");
    expect(runCliProcess).not.toHaveBeenCalled();
  });

  it("keeps retrying network failures for minutes but not subscription limits", () => {
    expect(cliRetryAttempts("network")).toBe(8);
    expect(cliRetryAttempts("rate_limited")).toBe(1);
    expect(cliRetryAttempts("bad_arguments")).toBe(3);
  });

  it("cancels during network backoff without starting another CLI turn", async () => {
    const controller = new AbortController();
    vi.mocked(runCliProcess).mockRejectedValue(
      new CliProcessError("Network unavailable", "network"),
    );
    const models = registerCliModelProviders(builtinModels());
    const model = models.getProvider("claude-code")!.getModels()[0]!;
    const result = models
      .streamSimple(
        model,
        { messages: [] },
        {
          apiKey: profileId,
          signal: controller.signal,
        },
      )
      .result();
    // Let the rejection reach the backoff timer, then cancel the waiting turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect((await result).stopReason).toBe("aborted");
    expect(runCliProcess).toHaveBeenCalledTimes(1);
  });

  it("does not retry a turn that hit the subscription limit", async () => {
    vi.mocked(runCliProcess).mockRejectedValue(
      new CliProcessError("CLI request failed.", "rate_limited"),
    );
    const models = registerCliModelProviders(builtinModels());
    const model = models.getProvider("claude-code")!.getModels()[0]!;
    const result = await models
      .streamSimple(model, { messages: [] }, { apiKey: profileId })
      .result();
    expect(result.stopReason).toBe("error");
    expect(runCliProcess).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation and failure without leaking CLI diagnostics or API fallback", async () => {
    vi.mocked(runCliProcess).mockRejectedValue(
      new Error("secret-access-token account@example.invalid"),
    );
    const models = registerCliModelProviders(builtinModels());
    const model = models.getProvider("antigravity-cli")!.getModels()[0]!;
    const result = await models
      .streamSimple(model, { messages: [] }, { apiKey: profileId })
      .result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/secret-access-token|account@example/);
    expect(result.errorMessage).toContain("No API fallback");
    // Two retries after a non-cancelled failure, then the error surfaces.
    expect(runCliProcess).toHaveBeenCalledTimes(3);
    const controller = new AbortController();
    vi.mocked(runCliProcess).mockImplementationOnce(async (options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw new Error("CLI request cancelled.");
    });
    const aborted = await models
      .streamSimple(model, { messages: [] }, { apiKey: profileId, signal: controller.signal })
      .result();
    expect(aborted.stopReason).toBe("aborted");
    // A cancelled turn is not retried.
    expect(runCliProcess).toHaveBeenCalledTimes(4);
  });

  it("gives a CLI turn ten minutes and retries a transient failure once", async () => {
    vi.mocked(runCliProcess)
      .mockRejectedValueOnce(new Error("CLI request timed out. Try again."))
      .mockResolvedValueOnce(output("codex-cli"));
    const models = registerCliModelProviders(builtinModels());
    const model = models.getProvider("codex-cli")!.getModels()[0]!;
    const result = await models
      .streamSimple(model, { messages: [] }, { apiKey: profileId, timeoutMs: 120_000 })
      .result();
    expect(result.stopReason).toBe("stop");
    expect(runCliProcess).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runCliProcess).mock.calls[0]?.[0].timeoutMs).toBe(600_000);
  });

  it("validates tool names, object arguments, and failed vendor responses", () => {
    expect(() =>
      parseCliReply('{"text":"","calls":[{"name":"host_shell","argumentsJson":"{}"}]}', new Set()),
    ).toThrow("unavailable tool");
    expect(() =>
      parseCliReply(
        '{"text":"","calls":[{"name":"lookup","argumentsJson":"[]"}]}',
        new Set(["lookup"]),
      ),
    ).toThrow("arguments");
    expect(parseCliReply('{"text":"","calls":[]}', new Set())).toEqual({ text: "", calls: [] });
    expect(() => parseCliReply("", new Set())).toThrow();
    expect(() => cliResponseText("codex-cli", '{"type":"turn.failed"}\n')).toThrow();
    expect(() => cliResponseText("claude-code", '{"is_error":true,"result":"private"}')).toThrow();
    for (const status of ["ERROR", "CANCELED", "WAITING", "RUNNING", "INVALID"])
      expect(() =>
        cliResponseText("antigravity-cli", JSON.stringify({ status, response: "private" })),
      ).toThrow();
    expect(
      cliResponseText(
        "antigravity-cli",
        JSON.stringify({ status: "SUCCESS", structured_output: answer }),
      ),
    ).toBe(JSON.stringify(answer));
  });

  it("uses fixed vendor protocols with native tools disabled", () => {
    const codex = cliInferenceArgs("codex-cli", "model", "schema");
    expect(codex).toContain("--ignore-user-config");
    expect(codex).toContain("--ephemeral");
    expect(codex).toContain('sandbox_mode="read-only"');
    const kept = cliInferenceArgs("codex-cli", "model", "schema", { persist: true });
    expect(kept).not.toContain("--ephemeral");
    expect(kept).toContain('sandbox_mode="read-only"');
    const resumed = cliInferenceArgs("codex-cli", "model", "schema", { resume: "thread-1" });
    expect(resumed.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(resumed.slice(-2)).toEqual(["thread-1", "-"]);
    expect(resumed).not.toContain("--sandbox");
    expect(resumed).toContain('sandbox_mode="read-only"');
    const bridged = cliInferenceArgs("codex-cli", "model", "schema", undefined, {
      url: "http://127.0.0.1:1/mcp",
      tokenEnv: "TOKEN",
    });
    expect(bridged).not.toContain("--output-schema");
    expect(bridged).not.toContain("code_mode_host");
    expect(bridged.join(" ")).toContain("--disable code_mode ");
    expect(bridged).toContain('mcp_servers.rakazo.default_tools_approval_mode="approve"');
    expect(codex).toContain("code_mode_host");
    const claude = cliInferenceArgs("claude-code", "model", "schema");
    expect(claude.slice(claude.indexOf("--tools"), claude.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    expect(claude).not.toContain("--bare");
    const agy = cliInferenceArgs("antigravity-cli", "model", "schema");
    expect(agy).toContain("--disable-slash-commands");
    expect(agy.slice(agy.indexOf("--json-schema"), agy.indexOf("--json-schema") + 2)).toEqual([
      "--json-schema",
      "schema",
    ]);
    expect(agy).not.toContain("--dangerously-skip-permissions");
    const grok = cliInferenceArgs("grok-cli", "model", "schema");
    expect(grok).toContain("--prompt-file");
    expect(grok).toContain("dontAsk");
    expect(grok).not.toContain("--always-approve");
  });

  it("keeps a long run inside the model window by shortening and dropping old steps", () => {
    const step = (index: number) => ({
      role: "toolResult" as const,
      toolCallId: `call-${index}`,
      toolName: "shell",
      content: [{ type: "text" as const, text: `output ${index} ${"x".repeat(5_000)}` }],
      isError: false,
      timestamp: index,
    });
    const messages = [
      { role: "user" as const, content: "Run the baseline", timestamp: 0 },
      ...Array.from({ length: 60 }, (_, index) => step(index + 1)),
    ];
    const bounded = boundCliMessages(messages, 60_000);
    const size = JSON.stringify(bounded).length;
    expect(size).toBeLessThanOrEqual(60_000 + 1_000);
    expect(bounded[0]).toEqual(messages[0]);
    expect(JSON.stringify(bounded[1])).toContain("earlier steps were omitted");
    // The most recent steps stay whole.
    expect(bounded.at(-1)).toEqual(messages.at(-1));
    expect(JSON.stringify(bounded)).toContain(`output 60 ${"x".repeat(5_000)}`);
  });

  it("keeps the latest user request when older steps are dropped", () => {
    const step = (index: number) => ({
      role: "toolResult" as const,
      toolCallId: `call-${index}`,
      toolName: "shell",
      content: [{ type: "text" as const, text: `output ${index} ${"x".repeat(5_000)}` }],
      isError: false,
      timestamp: index,
    });
    const request = `Use your own test database ${"y".repeat(3_000)}`;
    const messages = [
      { role: "user" as const, content: "Earlier chat", timestamp: 0 },
      ...Array.from({ length: 20 }, (_, index) => step(index + 1)),
      { role: "user" as const, content: [{ type: "text" as const, text: request }], timestamp: 21 },
      ...Array.from({ length: 40 }, (_, index) => step(index + 22)),
    ];
    const bounded = boundCliMessages(messages, 60_000);
    expect(bounded).toContainEqual(messages[21]);
    expect(JSON.stringify(bounded)).not.toContain("output 22 ");
  });

  it("replays repeated system messages into one with the current sections and tools", () => {
    const tool = (name: string) => ({
      name,
      description: `${name} ${"x".repeat(5_000)}`,
      parameters: { type: "object", properties: {} },
    });
    const system = (index: number) => ({
      role: "system" as const,
      content: index === 0 ? "Base prompt" : "",
      sections: { scratchpad: `step ${index}` },
      ...(index === 2
        ? { toolsRemoved: [{ name: "write_file" }] }
        : { toolsAdded: [tool("shell"), tool("write_file")] }),
      timestamp: index,
    });
    const messages = [
      system(0),
      { role: "user" as const, content: "Build it", timestamp: 0 },
      system(1),
      system(2),
    ] as Parameters<typeof collapseSystemMessages>[0];
    const collapsed = collapseSystemMessages(messages);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toMatchObject({
      role: "system",
      content: "Base prompt",
      sections: { scratchpad: "step 2" },
    });
    const tools = (collapsed[0] as { toolsAdded?: Array<{ name: string }> }).toolsAdded ?? [];
    expect(tools.map((item) => item.name)).toEqual(["shell"]);
    expect(collapsed[1]).toMatchObject({ role: "user", content: "Build it" });
  });

  it("leaves a tool result's details out of what the model sees", () => {
    const result = {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "read_history",
      content: [{ type: "text" as const, text: "3 messages" }],
      details: { payload: "z".repeat(1_000_000) },
      isError: false,
      timestamp: 1,
    } as Parameters<typeof modelVisibleMessage>[0];
    const visible = modelVisibleMessage(result);
    expect(JSON.stringify(visible)).not.toContain("payload");
    expect(visible).toMatchObject({ role: "toolResult", toolCallId: "call-1" });
  });

  it("omits the arguments of old tool calls that carried whole files", () => {
    const call = (index: number) => ({
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: `call-${index}`,
          name: "write_file",
          arguments: { path: `f${index}.ts`, content: "y".repeat(50_000) },
        },
      ],
      timestamp: index,
    });
    const messages = [
      { role: "user" as const, content: "Write the files", timestamp: 0 },
      ...Array.from({ length: 20 }, (_, index) => call(index + 1)),
    ] as Parameters<typeof boundCliMessages>[0];
    const bounded = boundCliMessages(messages, 400_000);
    const text = JSON.stringify(bounded);
    expect(text.length).toBeLessThanOrEqual(400_000);
    expect(text).toContain("characters of arguments omitted");
    expect(text).toContain("call-1");
  });

  it("trims a single huge latest tool result to its start and end", () => {
    const log = `gh pr diff 1\n${"x".repeat(3_000_000)}\nexit=0`;
    const messages = [
      { role: "user" as const, content: "Review the PR", timestamp: 0 },
      {
        role: "toolResult" as const,
        toolCallId: "call-1",
        toolName: "shell",
        content: [{ type: "text" as const, text: log }],
        isError: false,
        timestamp: 1,
      },
    ];
    const bounded = boundCliMessages(messages, 100_000);
    const text = JSON.stringify(bounded);
    expect(text.length).toBeLessThanOrEqual(100_000 + 1_000);
    expect(text).toContain("gh pr diff 1");
    expect(text).toContain("exit=0");
    expect(text).toContain("characters omitted to fit the model context");
  });

  it("leaves a conversation that already fits untouched", () => {
    const messages = [{ role: "user" as const, content: "Hello", timestamp: 0 }];
    expect(boundCliMessages(messages, 10_000)).toEqual(messages);
  });

  it("tells the model that the CLI sandbox does not limit Rakazo tools", async () => {
    vi.mocked(runCliProcess).mockResolvedValue(output("codex-cli"));
    const models = registerCliModelProviders(builtinModels());
    const model = models.getProvider("codex-cli")!.getModels()[0]!;
    await models
      .streamSimple(
        model,
        { messages: [{ role: "user", content: "Run it", timestamp: 0 }] },
        {
          apiKey: profileId,
        },
      )
      .result();
    expect(vi.mocked(runCliProcess).mock.calls[0]?.[0].input).toContain(
      "only restrict this CLI process",
    );
  });

  it("retries a failed CLI turn with a tighter context", async () => {
    vi.mocked(runCliProcess)
      .mockRejectedValueOnce(
        new Error("Codex CLI failed. Check sign-in, model access, and subscription limits."),
      )
      .mockResolvedValueOnce(output("codex-cli"));
    const models = registerCliModelProviders(builtinModels());
    const model = models.getProvider("codex-cli")!.getModels()[0]!;
    // Sized against the usage window that caps every CLI prompt.
    const window = Math.min(model.contextWindow, 100_000);
    const big = "x".repeat(Math.floor(window * 3 * 0.6 * 0.8));
    const messages = [
      { role: "user" as const, content: "Start", timestamp: 0 },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: "toolResult" as const,
        toolCallId: `call-${index}`,
        toolName: "shell",
        content: [{ type: "text" as const, text: big.slice(0, big.length / 30) }],
        isError: false,
        timestamp: index + 1,
      })),
    ];
    const result = await models.streamSimple(model, { messages }, { apiKey: profileId }).result();
    expect(result.stopReason).toBe("stop");
    const [first, second] = vi.mocked(runCliProcess).mock.calls.map((call) => call[0].input ?? "");
    expect(second!.length).toBeLessThan(first!.length);
  });

  it("accepts a namespaced tool name and names an unknown tool", () => {
    const reply = parseCliReply(
      JSON.stringify({ text: "", calls: [{ name: "functions.shell", argumentsJson: "{}" }] }),
      new Set(["shell"]),
    );
    expect(reply.calls[0]?.name).toBe("shell");
    expect(() =>
      parseCliReply(
        JSON.stringify({ text: "", calls: [{ name: "apply_patch", argumentsJson: "{}" }] }),
        new Set(["shell"]),
      ),
    ).toThrow(expect.objectContaining({ reason: "unknown_tool", toolName: "apply_patch" }));
  });

  it("repairs invalid escapes and double-encoded tool arguments", () => {
    expect(
      parseToolArguments(String.raw`{"command":"grep -E \"a\.b\" file | sed 's/\$//'"}`),
    ).toEqual({
      command: String.raw`grep -E "a\.b" file | sed 's/\$//'`,
    });
    expect(parseToolArguments('{"command":"cd app\n\tpnpm test",\n"cwd":"\\\\repo"}')).toEqual({
      command: "cd app\n\tpnpm test",
      cwd: "\\repo",
    });
    expect(
      parseToolArguments(
        String.raw`{"command":"psql -c \"SELECT 1\"\npython3 -c 'from pathlib import Path; print(Path("a.log").read_text())'","timeout":60}`,
      ),
    ).toEqual({
      command: `psql -c "SELECT 1"\npython3 -c 'from pathlib import Path; print(Path("a.log").read_text())'`,
      timeout: 60,
    });
    expect(parseToolArguments(JSON.stringify(JSON.stringify({ path: "a.txt" })))).toEqual({
      path: "a.txt",
    });
    const reply = parseCliReply(
      JSON.stringify({
        text: "",
        calls: [{ name: "shell", argumentsJson: String.raw`{"command":"echo \$HOME"}` }],
      }),
      new Set(["shell"]),
    );
    expect(JSON.parse(reply.calls[0]!.argumentsJson)).toEqual({ command: String.raw`echo \$HOME` });
  });

  it("caps Claude Code's context below a larger catalog window", async () => {
    vi.mocked(runCliProcess).mockResolvedValue(output("claude-code"));
    const models = registerCliModelProviders(builtinModels());
    const model = {
      ...models.getProvider("claude-code")!.getModels()[0]!,
      contextWindow: 1_000_000,
    };
    const messages = [
      { role: "user" as const, content: "Start", timestamp: 0 },
      ...Array.from({ length: 40 }, (_, index) => ({
        role: "toolResult" as const,
        toolCallId: `call-${index}`,
        toolName: "shell",
        content: [{ type: "text" as const, text: "测".repeat(20_000) }],
        isError: false,
        timestamp: index + 1,
      })),
    ];
    await models.streamSimple(model, { messages }, { apiKey: profileId }).result();
    const input = vi.mocked(runCliProcess).mock.calls[0]?.[0].input ?? "";
    // 200k tokens x 1.5 chars x 50% share, plus the fixed instructions.
    expect(input.length).toBeLessThan(160_000);
  });
});
