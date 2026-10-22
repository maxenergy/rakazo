import type { TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  codexResumeDelta,
  codexThreadId,
  forgetCodexThread,
  rememberCodexThread,
} from "./codex-cli-sessions.js";

type Message = TranscriptContext["messages"][number];

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as Message;
const assistant = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as unknown as Message;

describe("codex thread reuse", () => {
  it("resumes with only the messages added after the thread's own reply", () => {
    const first = [user("Start")];
    rememberCodexThread("profile", "thread:bot", "t-1", first, 100);
    const next = [...first, assistant("calls shell"), user("tool result")];
    expect(codexResumeDelta("profile", "thread:bot", next, 1_000)).toEqual({
      threadId: "t-1",
      messages: [user("tool result")],
      updated: [],
    });
  });

  it("resends tool results the runtime rewrote after the thread saw them", () => {
    const result = (text: string) =>
      ({
        role: "toolResult",
        toolCallId: "c1",
        content: [{ type: "text", text }],
      }) as unknown as Message;
    const first = [user("Start"), assistant("calls shell"), result("full output")];
    rememberCodexThread("profile", "rewrite", "t-2", first, 100);
    const next = [
      user("Start"),
      assistant("calls shell"),
      result("short"),
      assistant("next"),
      user("more"),
    ];
    expect(codexResumeDelta("profile", "rewrite", next, 1_000)).toEqual({
      threadId: "t-2",
      messages: [user("more")],
      updated: [result("short")],
    });
  });

  it("starts over when the history changed, grew too large, or has no session", () => {
    const first = [user("Start")];
    rememberCodexThread("profile", "s", "t-1", first, 100);
    const edited = [user("Condensed"), assistant("reply"), user("more")];
    expect(codexResumeDelta("profile", "s", edited, 1_000)).toBeUndefined();
    const next = [...first, assistant("reply"), user("more")];
    expect(codexResumeDelta("profile", "s", next, 100)).toBeUndefined();
    expect(codexResumeDelta("profile", undefined, next, 1_000)).toBeUndefined();
    forgetCodexThread("profile", "s");
    expect(codexResumeDelta("profile", "s", next, 1_000)).toBeUndefined();
  });

  it("reads the thread id from codex exec --json output", () => {
    const output = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.completed","usage":{}}',
    ].join("\n");
    expect(codexThreadId(output)).toBe("abc");
    expect(codexThreadId('{"type":"turn.completed"}')).toBeUndefined();
  });
});
