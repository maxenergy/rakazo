// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { MilestoneArtifactsLink } from "./MilestoneArtifactsLink";

it("links to artifacts filtered by the milestone and remains a visible touch target", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MilestoneArtifactsLink milestoneId="mile stone/1" />
        </MemoryRouter>,
      ),
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/artifacts?milestoneId=mile%20stone%2F1");
    expect(link?.textContent).toBe("View artifacts");
    expect(link?.className).toContain("min-h-11");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
