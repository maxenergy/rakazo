// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));

import { ProjectProgress } from "./ProjectProgress";

it("shows empty progress without a percentage bar and uses Ended for nonempty progress", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<ProjectProgress progress={{ completed: 0, total: 0, ratio: null }} />),
    );
    expect(container.textContent).toBe("0/0 · No tickets yet");
    expect(container.querySelector("progress")).toBeNull();
    await act(async () =>
      root.render(<ProjectProgress progress={{ completed: 2, total: 3, ratio: 2 / 3 }} />),
    );
    expect(container.textContent).toBe("2/3 · Ended");
    expect(container.textContent).not.toContain("Completed");
    expect(container.querySelector("progress")?.value).toBe(2);
    expect(container.querySelector("progress")?.max).toBe(3);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
