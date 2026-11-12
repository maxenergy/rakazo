// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ entries: vi.fn(), text: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce(
        (result, part, index) => result + (index ? String(values[index - 1]) : "") + part,
        "",
      ),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? children : null),
  DialogClose: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  DialogContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../lib/rpc", () => ({
  rpc: { artifacts: { zipEntries: mocks.entries, zipText: mocks.text } },
}));
vi.mock("../lib/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

import { ArtifactFileCard } from "./ArtifactFileCard";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.entries.mockResolvedValue([
    { path: "README.md", size: 12, directory: false },
    { path: "notes.txt", size: 7, directory: false },
    { path: "image.png", size: 3, directory: false },
  ]);
  mocks.text.mockImplementation(async ({ path }: { path: string }) => ({
    path,
    text: path === "README.md" ? "# Review" : "Second entry",
    size: 8,
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function openZip() {
  await act(async () =>
    root.render(
      <ArtifactFileCard
        target={{ botId: "bot" }}
        artifactId="artifact"
        name="review.zip"
        mimeType="application/zip"
        size={12}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Preview review.zip"]')?.click(),
  );
  await act(async () => Promise.resolve());
}

it("lists ZIP entries and switches the preview between text files", async () => {
  await openZip();
  expect(container.textContent).toContain("README.md");
  expect(container.querySelector<HTMLButtonElement>('[title="image.png"]')?.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('[title="README.md"]')?.click());
  expect(mocks.text).toHaveBeenCalledWith({ artifactId: "artifact", path: "README.md" });
  expect(container.textContent).toContain("# Review");
  await act(async () => container.querySelector<HTMLButtonElement>('[title="notes.txt"]')?.click());
  expect(container.textContent).toContain("Second entry");
  expect(container.textContent).not.toContain("# Review");
});

it("shows an explicit unsupported archive error", async () => {
  mocks.entries.mockRejectedValue(new Error("Unsupported, damaged or oversized ZIP archive."));
  await openZip();
  expect(container.textContent).toContain("Unsupported, damaged or oversized ZIP archive.");
});

it("shows an explicit oversized entry error", async () => {
  mocks.text.mockRejectedValue(
    new Error("This file is unsupported, damaged or too large to preview."),
  );
  await openZip();
  await act(async () => container.querySelector<HTMLButtonElement>('[title="README.md"]')?.click());
  expect(container.textContent).toContain(
    "This file is unsupported, damaged or too large to preview.",
  );
});
