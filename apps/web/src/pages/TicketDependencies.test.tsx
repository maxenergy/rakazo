// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dependencies: vi.fn(), list: vi.fn(), addDependency: vi.fn(), removeDependency: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { tickets: mocks } }));
vi.mock("@lingui/react/macro", () => ({ Trans: ({ children }: { children: ReactNode }) => children, useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }) }));
vi.mock("@rakazo/ui-web", () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />, Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> }));
import { TicketDependencies } from "./TicketDependencies";

it("adds and removes prerequisites and shows mutation errors", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const empty = { prerequisites: [], dependents: [], blockedByDependency: false };
  const prerequisite = { id: "b", ref: "RAK-2", title: "Prerequisite", status: "todo" };
  mocks.dependencies.mockResolvedValue(empty);
  mocks.list.mockResolvedValue({ tickets: [{ ...prerequisite, id: "a" }, prerequisite] });
  mocks.addDependency.mockResolvedValue({ ...empty, prerequisites: [prerequisite], blockedByDependency: true });
  mocks.removeDependency.mockRejectedValueOnce(new Error("Cannot remove dependency")).mockResolvedValue(empty);
  const container = document.createElement("div");
  const root = createRoot(container);
  const onSaved = vi.fn(async () => {});
  try {
    await act(async () => root.render(<TicketDependencies ticketId="a" onSaved={onSaved} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    const select = container.querySelector("select")!;
    expect(select.querySelectorAll("option[value='a']")).toHaveLength(0);
    await act(async () => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const button = (text: string) => Array.from(container.querySelectorAll("button")).find((item) => item.textContent === text)!;
    await act(async () => button("Add prerequisite").click());
    expect(mocks.addDependency).toHaveBeenCalledWith({ ticketId: "a", prerequisiteId: "b" });
    expect(container.querySelector("[role=status]")?.textContent).toContain("Blocked by");
    await act(async () => button("Remove").click());
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Cannot remove dependency");
    await act(async () => button("Remove").click());
    expect(mocks.removeDependency).toHaveBeenCalledWith({ ticketId: "a", prerequisiteId: "b" });
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("RAK-2: Prerequisite (todo)");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it("ignores a previous ticket read after switching tickets", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolveOld!: (value: unknown) => void;
  mocks.dependencies.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue({ prerequisites: [], dependents: [], blockedByDependency: false });
  mocks.list.mockResolvedValue({ tickets: [] });
  const container = document.createElement("div");
  const root = createRoot(container);
  const onSaved = async () => {};
  try {
    await act(async () => root.render(<TicketDependencies ticketId="old" onSaved={onSaved} />));
    await act(async () => root.render(<TicketDependencies ticketId="new" onSaved={onSaved} />));
    await act(async () => resolveOld({ prerequisites: [{ id: "stale", ref: "OLD-1", title: "Stale prerequisite", status: "todo" }], dependents: [], blockedByDependency: true }));
    expect(container.textContent).not.toContain("Stale prerequisite");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
