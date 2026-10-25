/** Only messages belonging to this project's runs enter an employee's next prompt. */
export function projectRunMessages<T extends { id: string; runId: string | null }>(
  messages: T[],
  runs: { id: string; sourceMessageId: string | null }[],
  sourceMessageId: string | null,
): T[] {
  const runIds = new Set(runs.map((run) => run.id));
  const sourceIds = new Set(runs.map((run) => run.sourceMessageId));
  return messages.filter(
    (message) =>
      (message.runId != null && runIds.has(message.runId)) ||
      sourceIds.has(message.id) ||
      message.id === sourceMessageId,
  );
}
