// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { directory, file, fileImage, commits } = vi.hoisted(() => ({
  directory: vi.fn(),
  file: vi.fn(),
  fileImage: vi.fn(),
  commits: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: { projects: { directory, file, fileImage, commits } },
  selectedSpaceId: () => "space",
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

import { ProjectFiles } from "./ProjectFiles";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  directory.mockResolvedValue([
    { name: "notes.md", type: "file", size: 12 },
    { name: "diagram.png", type: "file", size: 4 },
    { name: "src", type: "directory", size: 0 },
  ]);
  commits.mockResolvedValue([
    {
      sha: "1234567890",
      authoredAt: "2026-01-01T00:00:00Z",
      author: "Dev",
      subject: "Initial commit",
    },
  ]);
  await act(async () => root.render(<ProjectFiles projectId="project" />));
  dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
async function click(container: HTMLElement, label: string) {
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)?.click(),
  );
}

it("navigates directories, previews Markdown, and lists commits", async () => {
  const c = await render();
  await click(c, "▸ src");
  expect(directory).toHaveBeenLastCalledWith(
    { projectId: "project", path: "src" },
    { context: { spaceId: "space" } },
  );
  file.mockResolvedValue({ text: "# Preview", size: 9 });
  await click(c, "notes.md");
  expect(c.querySelector('[data-testid="markdown"]')?.textContent).toBe("# Preview");
  await click(c, "Recent commits");
  expect(c.textContent).toContain("Initial commit");
});

it("renders image bytes from projects.fileImage as a data URL", async () => {
  const c = await render();
  fileImage.mockResolvedValue({ mime: "image/png", size: 4, dataBase64: "aGVsbG8=" });
  await click(c, "diagram.png");
  expect(fileImage).toHaveBeenCalledWith(
    { projectId: "project", path: "diagram.png" },
    { context: { spaceId: "space" } },
  );
  expect(c.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
});

it("shows clear denied and over-limit messages", async () => {
  const c = await render();
  file.mockRejectedValueOnce(new Error("Access denied"));
  await click(c, "notes.md");
  expect(c.textContent).toContain("access was denied");
  file.mockRejectedValueOnce(new Error("File exceeds the maximum limit"));
  await click(c, "notes.md");
  expect(c.textContent).toContain("exceeds the preview limit");
});

it("keeps files available when a project has no Git history", async () => {
  commits.mockRejectedValue(new Error("Resource not found."));
  const c = await render();
  expect(c.textContent).toContain("notes.md");
  await click(c, "Recent commits");
  expect(c.textContent).toContain("no Git history");
});
