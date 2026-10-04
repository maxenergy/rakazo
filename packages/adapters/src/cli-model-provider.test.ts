import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliModelProvider } from "./cli-model-process.js";
import { CLI_MODEL_PROVIDERS, runCliProcess } from "./cli-model-process.js";
import {
  cliInferenceArgs,
  cliResponseText,
  parseCliReply,
  registerCliModelProviders,
} from "./cli-model-provider.js";

vi.mock("./cli-model-process.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runCliProcess: vi.fn(),
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
    expect(runCliProcess).toHaveBeenCalledOnce();
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
    expect(runCliProcess).toHaveBeenCalledTimes(2);
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
    expect(() => parseCliReply('{"text":"","calls":[]}', new Set())).toThrow("empty");
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
    expect(codex).toContain("read-only");
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
});
