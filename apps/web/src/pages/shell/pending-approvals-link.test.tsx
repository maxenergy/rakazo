// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ proposals: { list: vi.fn() } }));
vi.mock("../../lib/rpc", () => ({ rpc: api }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { PendingApprovalsLink } from "./pending-approvals-link";

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <PendingApprovalsLink />
      </MemoryRouter>,
    ),
  );
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("shows the pending count and hides when nothing waits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.proposals.list.mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }]);
  const shown = await render();
  expect(api.proposals.list).toHaveBeenCalledWith({ status: "pending" });
  expect(shown.container.querySelector('[data-testid="pending-approvals-link"]')?.textContent).toBe(
    "Approvals2",
  );
  await shown.cleanup();

  api.proposals.list.mockResolvedValueOnce([]);
  const hidden = await render();
  expect(hidden.container.querySelector('[data-testid="pending-approvals-link"]')).toBeNull();
  await hidden.cleanup();
});
