/** Worker-owned configuration; never accepted from model/tool arguments. */
export function recordOnlyRoutine(
  run: { routineId?: string | null; trigger: string },
  configured = process.env.RECORD_ONLY_ROUTINE_IDS,
): boolean {
  // Preserve protection for queued runs even if the operator later clears selection.
  if (run.trigger === "org_check_in_record_only") return true;
  return (
    run.trigger === "routine" &&
    Boolean(run.routineId) &&
    (configured ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .includes(run.routineId!)
  );
}

// Keep this deliberately small. Connector metadata never grants admission.
const READ_TOOLS = new Set(["ticket_get", "board_tickets", "read_file", "list_files"]);
export function recordOnlyAllowsTool(name: string, route?: unknown): boolean {
  return !route && READ_TOOLS.has(name);
}

export const RECORD_ONLY_MODEL_ERROR =
  "Record-only run: model provider has no verified tool-free path; model was not started.";

export function recordOnlyAllowsProvider(provider: string, api?: string): boolean {
  if (provider === "claude-code") return api === undefined || api === "rakazo-cli";
  if (provider.endsWith("-cli") || api === "rakazo-cli") return false;
  // Explicit API transports, all tool execution is dispatched through the runtime.
  return (
    api !== undefined &&
    new Set([
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
      "openai-codex-responses",
      "google-generative-ai",
      "google-vertex",
      "google-gemini-cli",
      "bedrock-converse-stream",
    ]).has(api)
  );
}
