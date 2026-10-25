[object Object]it("keeps routines disabled for a paused project", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onEnableRoutine = vi.fn().mockResolvedValue(undefined);
  const routine = {
    id: "routine-1",
    botId: "bot-1",
    projectId: "project-1",
    name: "Weekly summary",
    prompt: "Summarize",
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    active: false,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await act(async () => root.render(
    <BotRestorePreview
      botName="Restored bot"
      preview={{
        projects: [{ id: "project-1", name: "Paused project", status: "paused", archivedAt: null, member: true }],
        tickets: [],
        routines: [routine],
      }}
      onCancel={() => undefined}
      onConfirmRestore={vi.fn().mockResolvedValue(undefined)}
      onEnableRoutine={onEnableRoutine}
    />,
  ));
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  expect(container.textContent).toContain("Paused project");
  expect(container.textContent).toContain("Project paused");
  const enable = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Enable"))!;
  expect(enable.disabled).toBe(true);
  await act(async () => enable.click());
  expect(onEnableRoutine).not.toHaveBeenCalled();
});
