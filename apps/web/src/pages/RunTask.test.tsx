// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
const diagnostics = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: { runs: { diagnostics } } }));

import { RunTask } from "./RunTask";

it("loads only the selected message run on opening and fetches fresh state on reopening", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  diagnostics.mockResolvedValue({
    status: "completed",
    entries: [],
    nextCursor: null,
    windowStartedAt: "2026-10-22T05:00:00.000Z",
  });
  try {
    await act(async () => root.render(<RunTask runId="message-run" />));
    expect(diagnostics).not.toHaveBeenCalled();
    const details = container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(diagnostics).toHaveBeenLastCalledWith({
      runId: "message-run",
      section: "attempts",
      limit: 25,
    });
    expect(container.textContent).toContain("Run status: Done");
    await act(async () => {
      details.open = false;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(container.querySelector("section")).toBeNull();
    diagnostics.mockClear();
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(diagnostics).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    diagnostics.mockReset();
    vi.unstubAllGlobals();
  }
});
