// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const { setBudget } = vi.hoisted(() => ({ setBudget: vi.fn(async () => ({})) }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => "space-a",
  rpc: { projects: { budget: vi.fn(), setBudget } },
}));
vi.mock("../lib/use-board-refresh", () => ({
  useBoardRefresh: () => ({
    data: { limitMicroUsd: "9007199254740993", reservedMicroUsd: "2", settledMicroUsd: "1" },
  }),
}));

import { ProjectBudget } from "./ProjectBudget";

it("submits exact decimal USD and rejects invalid amounts without changing the budget", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setBudget.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ProjectBudget projectId="project-a" />));
    expect(container.textContent).toContain("$9007199254.740993");
    expect(container.textContent).toContain("$9007199254.740990");
    const input = container.querySelector("input")!;
    const form = container.querySelector("form")!;
    async function submit(value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    }
    await submit("12.345678");
    expect(setBudget).toHaveBeenCalledWith(
      { projectId: "project-a", limitMicroUsd: "12345678" },
      { context: { spaceId: "space-a" } },
    );
    for (const invalid of ["-1", "1.0000001", "1e3", "9223372036854.775808"]) {
      setBudget.mockClear();
      await submit(invalid);
      expect(setBudget).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    }
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
