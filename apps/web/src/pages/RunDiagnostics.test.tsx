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
  diagnostics.mockResolvedValue({
    runId: "run-1",
    status: "uncertain",
    section: "attempts",
    entries: [],
    nextCursor: cursor,
    windowStartedAt: cursor.at,
    historyMayBeIncomplete: true,
  });
  try {
    await act(async () => root.render(<RunDiagnostics runId="run-1" />));
    expect(container.textContent).toContain("Run status: uncertain");
    expect(container.textContent).toContain("Missing evidence does not establish success.");
    expect(container.textContent).toContain("No recorded evidence in this window.");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(diagnostics).toHaveBeenLastCalledWith({
      runId: "run-1",
      section: "attempts",
      limit: 25,
      before: cursor,
    });
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "usage";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(diagnostics).toHaveBeenLastCalledWith({ runId: "run-1", section: "usage", limit: 25 });
    diagnostics.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => {
      select.value = "effects";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Diagnostics could not be loaded.",
    );
    expect(container.textContent).not.toContain("Run status:");
  } finally {
    await act(async () => root.unmount());
    diagnostics.mockReset();
    vi.unstubAllGlobals();
  }
});

it("ignores a stale response after switching runs", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  let resolveOld!: (value: unknown) => void;
  diagnostics.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  diagnostics.mockResolvedValue({
    runId: "run-2",
    status: "uncertain",
    section: "attempts",
    entries: [],
    nextCursor: null,
    windowStartedAt: "2026-10-22T05:00:00.000Z",
    historyMayBeIncomplete: true,
  });
  try {
    await act(async () => root.render(<RunDiagnostics runId="run-1" />));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => root.render(<RunDiagnostics runId="run-2" />));
    expect(diagnostics).toHaveBeenLastCalledWith({
      runId: "run-2",
      section: "attempts",
      limit: 25,
    });
    await act(async () =>
      resolveOld({
        runId: "run-1",
        status: "completed",
        section: "attempts",
        entries: [],
        nextCursor: null,
        windowStartedAt: "2026-10-22T05:00:00.000Z",
        historyMayBeIncomplete: true,
      }),
    );
    expect(container.textContent).toContain("Run status: uncertain");
    expect(container.textContent).not.toContain("Run status: completed");
  } finally {
    await act(async () => root.unmount());
    diagnostics.mockReset();
    vi.unstubAllGlobals();
  }
});

it("renders recorded usage, derived changes, recovery and source navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const at = "2026-10-22T05:00:00.000Z";
  const base = {
    at,
    status: null,
    fence: null,
    finishedAt: null,
    provider: null,
    model: null,
    callId: null,
    inputTokens: null,
    outputTokens: null,
    costMicroUsd: null,
    evidence: {
      runId: "run-1",
      threadId: "thread-1",
      eventSeq: 7,
      sourceHref: "/app/bot-1?m=message-1",
    },
  };
  diagnostics.mockResolvedValue({
    runId: "run-1",
    status: "uncertain",
    section: "events",
    entries: [
      {
        ...base,
        id: "usage-1",
        kind: "usage",
        provider: "provider",
        model: "backup",
        callId: "call-1",
        inputTokens: 12,
        outputTokens: 34,
        costMicroUsd: "56",
        derived: "model_changed",
      },
      { ...base, id: "attempt-1", kind: "attempt", fence: 2, derived: "lease_takeover" },
      {
        ...base,
        id: "event-1",
        kind: "effect.reconciled",
        recovery: {
          match: "matched",
          legacy: false,
          effect: {
            id: "effect-1",
            kind: "tool",
            status: "completed",
            reviewDecision: "approved",
            createdAt: at,
          },
        },
      },
      {
        ...base,
        id: "event-2",
        kind: "effect.reconciled",
        recovery: { match: "unmatched", legacy: true, effect: null },
      },
    ],
    nextCursor: null,
    windowStartedAt: at,
    historyMayBeIncomplete: true,
  });
  try {
    await act(async () => root.render(<RunDiagnostics runId="run-1" />));
    expect(container.textContent).toContain("Model changed");
    expect(container.textContent).toContain("Lease takeover");
    expect(container.textContent).toContain("Recovery: matched");
    expect(container.textContent).toContain("Recovery: unmatched · Legacy");
    expect(container.textContent).toContain("Review: approved");
    expect(container.textContent).toContain("backup");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/app/bot-1?m=message-1");
  } finally {
    await act(async () => root.unmount());
    diagnostics.mockReset();
    vi.unstubAllGlobals();
  }
});
