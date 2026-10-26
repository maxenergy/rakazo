// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const capability = vi.hoisted(() => ({
  state: "pending" as "pending" | "enabled" | "disabled",
  boardLoaded: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("./lib/bootstrap", () => ({
  getTicketBoardCapability: () => capability.state,
  subscribeTicketBoardCapability: () => () => {},
}));
vi.mock("./lib/auth", () => ({
  authClient: {
    useSession: () => ({ isPending: false, data: { user: { id: "user-1" } }, refetch: vi.fn() }),
  },
}));
vi.mock("./lib/remote-images-preference", () => ({
  getRemoteImagesEnabled: () => false,
  subscribeRemoteImages: () => () => {},
}));
vi.mock("./lib/performance", () => ({ markOnce: () => {}, markAfterPaint: () => {} }));
vi.mock("./lib/rpc", () => ({ rpc: {} }));
vi.mock("./components/SubscriptionGate", () => ({
  SubscriptionGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Shell", () => ({ ShellPage: () => <div>Shell</div> }));
vi.mock("./pages/Board", () => {
  capability.boardLoaded();
  return { BoardPage: () => <div>Board page</div> };
});
vi.mock("./pages/Projects", () => ({ ProjectsPage: () => <div>Projects page</div> }));
vi.mock("./pages/IntegrationSetup", () => ({ IntegrationSetupPage: () => null }));
vi.mock("./pages/LocalSettings", () => ({ LocalSettingsPage: () => null }));
vi.mock("./pages/McpOAuthCallback", () => ({ McpOAuthCallbackPage: () => null }));

import { App } from "./App";

it("loads the board chunk only after bootstrap enables the route", async () => {
  capability.state = "pending";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () => (
    <MemoryRouter initialEntries={["/app/board"]}>
      <App />
    </MemoryRouter>
  );
  try {
    await act(async () => root.render(render()));
    expect(container.textContent).toContain("Loading");
    expect(capability.boardLoaded).not.toHaveBeenCalled();
    capability.state = "enabled";
    await act(async () => {
      root.render(render());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(capability.boardLoaded).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("Board page");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each([
  "/app/board",
  "/app/tickets",
  "/app/projects",
  "/app/projects/project-1",
  "/app/projects/project-1/milestones/milestone-1",
])("keeps %s unavailable when the feature is disabled", async (path) => {
  capability.state = "disabled";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      ),
    );
    expect(container.textContent).not.toContain("Board page");
    expect(container.textContent).not.toContain("Projects page");
    expect(container.querySelector("progress")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
