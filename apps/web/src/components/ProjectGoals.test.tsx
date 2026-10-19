// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGoal: vi.fn(),
  deleteGoal: vi.fn(),
  deleteResult: vi.fn(),
  archiveResult: vi.fn(),
  goals: vi.fn(),
  results: vi.fn(),
  milestones: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("../lib/user-error", () => ({
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("./GoalEditor", () => ({ GoalEditor: () => <div>Editor</div> }));
vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => "space-a",
  rpc: {
    goals: { list: mocks.goals, create: mocks.createGoal, delete: mocks.deleteGoal },
    keyResults: { list: mocks.results, delete: mocks.deleteResult, archive: mocks.archiveResult },
    milestones: { list: mocks.milestones },
  },
}));
vi.mock("../lib/use-board-refresh", () => ({
  useBoardRefresh: (load: (spaceId: string) => Promise<unknown>) => {
    const [data, setData] = useState<unknown>();
    useEffect(() => {
      let active = true;
      void load("space-a").then((value) => {
        if (active) setData(value);
      });
      return () => {
        active = false;
      };
    }, [load]);
    return { data };
  },
}));

import { ProjectGoals } from "./ProjectGoals";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.deleteGoal.mockReset().mockResolvedValue({});
  mocks.deleteResult.mockReset().mockResolvedValue({});
  mocks.archiveResult.mockReset().mockResolvedValue({});
  mocks.createGoal.mockReset().mockResolvedValue({ id: "created-goal" });
  mocks.goals
    .mockReset()
    .mockResolvedValue([{ id: "goal-a", name: "Goal A", state: "active", archived: false }]);
  mocks.results.mockReset().mockResolvedValue([
    {
      id: "result-a",
      name: "Result A",
      state: "active",
      archived: false,
      currentValue: 12,
      targetValue: 10,
      measure: "items",
      calculationRule: "Count verified items",
    },
  ]);
  mocks.milestones.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
async function mount(readOnly = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<ProjectGoals projectId="project-a" readOnly={readOnly} />));
  return container;
}
it("filters archived key results independently of active goals", async () => {
  const container = await mount();
  const label = Array.from(container.querySelectorAll("label")).find((item) =>
    item.textContent?.includes("Archived key results"),
  );
  const checkbox = label?.querySelector<HTMLInputElement>("input");
  expect(checkbox).toBeTruthy();
  await act(async () => checkbox!.click());
  expect(mocks.goals).toHaveBeenLastCalledWith(
    { projectId: "project-a", archived: false },
    { context: { spaceId: "space-a" } },
  );
  expect(mocks.results).toHaveBeenLastCalledWith(
    { goalId: "goal-a", archived: true },
    { context: { spaceId: "space-a" } },
  );
});
it("hides mutation controls for an archived project while retaining readable results", async () => {
  const container = await mount(true);
  expect(container.textContent).toContain("Goal A");
  expect(container.textContent).toContain("Result A");
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).not.toContain("Editor");
});
it("hides mutation controls for archived goals", async () => {
  mocks.goals.mockResolvedValue([
    { id: "goal-a", name: "Archived goal", state: "active", archived: true },
  ]);
  mocks.results.mockResolvedValue([]);
  const container = await mount();
  const goal = container.querySelector("li");
  expect(goal?.textContent).toContain("Archived goal");
  expect(goal?.querySelector("button")).toBeNull();
  expect(goal?.textContent).not.toContain("Editor");
});

it("hides editing for a KR linked to an archived milestone", async () => {
  mocks.milestones.mockImplementation(async (input) =>
    input.archived ? [{ id: "milestone-a", name: "Archived milestone", archived: true }] : [],
  );
  mocks.results.mockResolvedValue([
    {
      id: "result-a",
      name: "Result A",
      state: "active",
      archived: false,
      milestoneId: "milestone-a",
      currentValue: 1,
      targetValue: 10,
      measure: "items",
      calculationRule: "Count verified items",
    },
  ]);
  const container = await mount();
  const result = Array.from(container.querySelectorAll("li")).find(
    (item) => item.textContent?.includes("Result A") && !item.textContent?.includes("Goal A"),
  );
  expect(result).toBeTruthy();
  expect(result?.textContent).not.toContain("Edit key result");
});

async function enterGoalName(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>("form input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}
it("preserves entered goal name when the server rejects creation", async () => {
  mocks.createGoal.mockRejectedValue(new Error("Forbidden"));
  const container = await mount();
  const input = await enterGoalName(container, "Keep this name");
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.createGoal).toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Forbidden");
  expect(input.value).toBe("Keep this name");
});
it("reloads authoritative goals after successful creation", async () => {
  const container = await mount();
  const input = await enterGoalName(container, "New goal");
  mocks.goals.mockResolvedValue([
    { id: "created-goal", name: "Server goal", state: "planned", archived: false },
  ]);
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.createGoal).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "project-a", name: "New goal" }),
    { context: { spaceId: "space-a" } },
  );
  expect(mocks.goals).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Server goal");
  expect(input.value).toBe("");
});

function button(container: HTMLElement, name: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
it("confirms goal deletion and explains the key result cascade", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    const container = await mount();
    await act(async () => button(container, "Delete goal").click());
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/all its key results/i));
    expect(mocks.deleteGoal).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await act(async () => button(container, "Delete goal").click());
    expect(mocks.deleteGoal).toHaveBeenCalledWith(
      { id: "goal-a" },
      { context: { spaceId: "space-a" } },
    );
  } finally {
    confirm.mockRestore();
  }
});
it("requires confirmation before deleting a key result", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    const container = await mount();
    await act(async () => button(container, "Delete key result").click());
    expect(mocks.deleteResult).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await act(async () => button(container, "Delete key result").click());
    expect(mocks.deleteResult).toHaveBeenCalledWith(
      { id: "result-a" },
      { context: { spaceId: "space-a" } },
    );
  } finally {
    confirm.mockRestore();
  }
});
it("archives a key result and reloads authoritative data", async () => {
  const container = await mount();
  await act(async () => button(container, "Archive key result").click());
  expect(mocks.archiveResult).toHaveBeenCalledWith(
    { id: "result-a" },
    { context: { spaceId: "space-a" } },
  );
  expect(mocks.goals).toHaveBeenCalledTimes(2);
});
it("clamps progress without changing the explicit key result state", async () => {
  const container = await mount();
  expect(container.querySelector("progress")?.value).toBe(100);
  expect(container.textContent).toContain("active");
});
it.each([0, Number.NaN])("shows no data for an unusable target %s", async (targetValue) => {
  mocks.results.mockResolvedValue([
    {
      id: "result-a",
      name: "Result A",
      state: "active",
      archived: false,
      currentValue: 3,
      targetValue,
      measure: "items",
      calculationRule: "Count",
    },
  ]);
  const container = await mount();
  expect(container.querySelector("progress")).toBeNull();
  expect(container.textContent).toContain("No data");
});
it.each([
  ["active", true],
  ["achieved", false],
  ["cancelled", false],
])("flags overdue results only for unfinished state %s", async (state, overdue) => {
  mocks.results.mockResolvedValue([
    {
      id: "result-a",
      name: "Result A",
      state,
      archived: false,
      currentValue: 3,
      targetValue: 10,
      dueAt: "2000-01-01T00:00:00.000Z",
      measure: "items",
      calculationRule: "Count",
    },
  ]);
  const container = await mount();
  expect(container.textContent?.includes("Overdue")).toBe(overdue);
});
it("shows mutation failures without reporting successful refresh", async () => {
  mocks.archiveResult.mockRejectedValue(new Error("Archive rejected"));
  const container = await mount();
  await act(async () => button(container, "Archive key result").click());
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Archive rejected");
  expect(mocks.goals).toHaveBeenCalledTimes(1);
});

it.each([
  [0, false],
  [-1, true],
])("compares due dates by calendar day (offset %s)", async (offset, overdue) => {
  const now = new Date();
  const due = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  mocks.results.mockResolvedValue([
    {
      id: "result-date",
      name: "Date boundary",
      state: "active",
      archived: false,
      currentValue: 3,
      targetValue: 10,
      dueAt: due.toISOString(),
      measure: "items",
      calculationRule: "Count",
    },
  ]);
  const container = await mount();
  expect(container.textContent?.includes("Overdue")).toBe(overdue);
});
