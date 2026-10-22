// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: { runs: { diagnostics } } }));
import { RunDiagnostics } from "./RunDiagnostics";

it("shows uncertain evidence, paginates, and resets the cursor on category change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const cursor = { at: "2026-10-22T05:00:00.000Z", id: "attempt-1" };
  diagnostics.mockResolvedValue({ runId: "run-1", status: "uncertain", section: "attempts", entries: [], nextCursor: cursor, windowStartedAt: cursor.at, historyMayBeIncomplete: true });
  try {
    await act(async () => root.render(<RunDiagnostics runId="run-1" />));
    expect(container.textContent).toContain("Run status: uncertain");
    expect(container.textContent).toContain("Missing evidence does not establish success.");
    expect(container.textContent).toContain("No recorded evidence in this window.");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(diagnostics).toHaveBeenLastCalledWith({ runId: "run-1", section: "attempts", limit: 25, before: cursor });
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "usage"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(diagnostics).toHaveBeenLastCalledWith({ runId: "run-1", section: "usage", limit: 25 });
    diagnostics.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => { select.value = "effects"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Diagnostics could not be loaded.");
    expect(container.textContent).not.toContain("Run status:");
  } finally {
    await act(async () => root.unmount());
    diagnostics.mockReset();
    vi.unstubAllGlobals();
  }
});
