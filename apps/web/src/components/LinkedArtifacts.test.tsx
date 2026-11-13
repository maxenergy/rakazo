// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const listSpace = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: { artifacts: { listSpace } } }));
vi.mock("./ArtifactFileCard", () => ({
  ArtifactFileCard: ({ name }: { name: string }) => <button type="button">Preview {name}</button>,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { LinkedArtifacts } from "./LinkedArtifacts";

const item = (id: string, name: string) => ({
  id,
  botId: "bot-1",
  groupId: null,
  runId: null,
  name,
  description: null,
  mimeType: "text/markdown",
  size: 10,
  version: 1,
  createdAt: "2026-11-12T00:00:00Z",
  versionCount: 1,
});

it("filters linked artifacts, opens the existing preview, and pages without omissions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listSpace.mockResolvedValueOnce({ items: [item("a", "First")], nextCursor: "next" });
  listSpace.mockResolvedValueOnce({ items: [item("b", "Second")], nextCursor: null });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<LinkedArtifacts projectId="project-1" />));
  try {
    expect(listSpace).toHaveBeenCalledWith({ projectId: "project-1", limit: 60 });
    expect(container.textContent).toContain("Preview First");
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more",
    );
    await act(async () => more?.click());
    expect(listSpace).toHaveBeenLastCalledWith({
      projectId: "project-1",
      cursor: "next",
      limit: 60,
    });
    expect(container.textContent).toContain("Preview Second");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("shows an empty state for tickets with no linked artifacts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listSpace.mockResolvedValueOnce({ items: [], nextCursor: null });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<LinkedArtifacts ticketId="ticket-1" />));
  try {
    expect(listSpace).toHaveBeenCalledWith({ ticketId: "ticket-1", limit: 60 });
    expect(container.textContent).toContain("No artifacts");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
