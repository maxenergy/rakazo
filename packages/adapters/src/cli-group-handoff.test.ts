import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { runCliProcess } from "./cli-model-process.js";
import { MISSING_TOOL_FINAL_RESPONSE_ERROR, PiAgentRuntime } from "./pi-runtime.js";

vi.mock("./cli-model-process.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runCliProcess: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

function reply(text: string, calls: { name: string; argumentsJson: string }[] = []) {
  return JSON.stringify({ is_error: false, structured_output: { text, calls } });
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "specialist",
    threadId: "group",
    runId: "group-turn",
    prompt: "Complete the technical stage and hand the next stage to the coordinator.",
    instructions: "Write the plan before transferring ownership.",
    history: [],
    tools: builtinAgentTools.filter(({ name }) => ["write_file", "handoff_to_bot"].includes(name)),
    model: {
      provider: "claude-code",
      id: "claude-opus-5-5",
      apiKey: "11111111-1111-4111-8111-111111111111",
    },
    ...overrides,
  };
}

async function collect(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input)) events.push(event);
  return events;
}

describe("CLI group ownership transfer through real Pi", () => {
  it("ends after a successful handoff without another CLI request or final-answer recovery", async () => {
    vi.mocked(runCliProcess).mockResolvedValueOnce(
      reply("", [
        { name: "write_file", argumentsJson: '{"path":"shared/plan.md","content":"Generic plan"}' },
        {
          name: "handoff_to_bot",
          argumentsJson: '{"confirm_name":"Coordinator","message":"Review the completed plan."}',
        },
      ]),
    );
    let handedOff = false;
    const executed: string[] = [];
    const events = await collect(
      request({
        shouldEndTurn: () => handedOff,
        executeTool: async (name) => {
          executed.push(name);
          if (name === "handoff_to_bot") handedOff = true;
          return { ok: true };
        },
      }),
    );
    expect(executed).toEqual(["write_file", "handoff_to_bot"]);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.filter((event) => event.type === "text")).toEqual([]);
    expect(runCliProcess).toHaveBeenCalledOnce();
  });

  it("continues after a rejected handoff so the bot can report the error", async () => {
    vi.mocked(runCliProcess)
      .mockResolvedValueOnce(
        reply("", [
          {
            name: "handoff_to_bot",
            argumentsJson: '{"confirm_name":"Missing","message":"Review the plan."}',
          },
        ]),
      )
      .mockResolvedValueOnce(reply("The teammate is unavailable."));
    const events = await collect(
      request({
        shouldEndTurn: () => false,
        executeTool: async () => ({ error: "handoff target is not a group member" }),
      }),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "The teammate is unavailable." });
    expect(runCliProcess).toHaveBeenCalledTimes(2);
  });

  it("keeps normal tool work pending when the model omits the required final answer", async () => {
    vi.mocked(runCliProcess)
      .mockResolvedValueOnce(
        reply("", [
          { name: "write_file", argumentsJson: '{"path":"notes.txt","content":"Generic plan"}' },
        ]),
      )
      .mockResolvedValue(reply(""));
    await expect(collect(request({ executeTool: async () => ({ ok: true }) }))).rejects.toThrow(
      MISSING_TOOL_FINAL_RESPONSE_ERROR,
    );
  });
});
