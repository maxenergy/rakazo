// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { workdir, update } = vi.hoisted(() => ({ workdir: vi.fn(), update: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: { projects: { workdir, update } },
  selectedSpaceId: () => "space",
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("./ProjectFiles", () => ({ ProjectFiles: () => <p>Bound files</p> }));

import { ProjectWorkdir } from "./ProjectWorkdir";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("offers binding for an unbound project and opens files after saving", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  workdir.mockResolvedValue({ path: null });
  update.mockResolvedValue({});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ProjectWorkdir projectId="project" />));
    expect(container.textContent).toContain("No working directory is bound");
    expect(container.textContent).not.toContain("Bound files");
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "shared/project/repo",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(update).toHaveBeenCalledWith(
      { id: "project", workdirPath: "shared/project/repo" },
      { context: { spaceId: "space" } },
    );
    expect(container.textContent).toContain("Bound files");
    expect(container.textContent).not.toContain("No working directory is bound");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
