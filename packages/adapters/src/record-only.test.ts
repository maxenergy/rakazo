import { describe, expect, it } from "vitest";
import {
  recordOnlyAllowsProvider,
  recordOnlyAllowsTool,
  recordOnlyRoutine,
} from "./record-only.js";

describe("record-only policy", () => {
  it("selects only configured routine runs and excludes org check-ins", () => {
    expect(recordOnlyRoutine({ trigger: "routine", routineId: "chosen" }, " other, chosen ")).toBe(
      true,
    );
    expect(recordOnlyRoutine({ trigger: "routine", routineId: "other" }, "")).toBe(false);
    expect(recordOnlyRoutine({ trigger: "org_check_in", routineId: "chosen" }, "chosen")).toBe(
      false,
    );
    expect(recordOnlyRoutine({ trigger: "routine" }, "chosen")).toBe(false);
  });

  it("always protects the dedicated org trigger, independently of later configuration", () => {
    expect(recordOnlyRoutine({ trigger: "org_check_in_record_only" }, "")).toBe(true);
    expect(recordOnlyRoutine({ trigger: "org_check_in" }, "")).toBe(false);
  });

  it("admits only the minimal builtins, never connector routes or metadata", () => {
    for (const name of ["ticket_get", "board_tickets", "read_file", "list_files"]) {
      expect(recordOnlyAllowsTool(name)).toBe(true);
      expect(recordOnlyAllowsTool(name, { readOnly: true })).toBe(false);
    }
    for (const name of [
      "shell",
      "web_fetch",
      "browser_act",
      "run_subagent",
      "ticket_update",
      "unknown",
    ]) {
      expect(recordOnlyAllowsTool(name)).toBe(false);
    }
  });

  it("defaults unknown transports to refusal and admits the verified argument path", () => {
    expect(recordOnlyAllowsProvider("claude-code", "rakazo-cli")).toBe(true);
    expect(recordOnlyAllowsProvider("codex-cli", "rakazo-cli")).toBe(false);
    expect(recordOnlyAllowsProvider("grok-cli", "rakazo-cli")).toBe(false);
    expect(recordOnlyAllowsProvider("unknown", "unknown")).toBe(false);
    expect(recordOnlyAllowsProvider("openai", "openai-responses")).toBe(true);
  });
});
