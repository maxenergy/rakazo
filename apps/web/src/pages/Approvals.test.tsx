// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  proposals: { list: vi.fn(), decide: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({ rpc: api }));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "5m ago" }));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { ApprovalsPage } from "./Approvals";

function proposal(id: string, status: "pending" | "approved" | "rejected" | "expired" | "stale", options: string[] = []) {
  return {
    id,
    botId: "ceo-1",
    botName: "CEO",
    kind: "plan" as const,
    title: `Plan ${id}`,
    summary: "Ship the launch site",
    options,
    recommendation: "",
    status,
    chosenOption: null,
    comment: null,
    decidedAt: status === "pending" ? null : new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function setFieldValue(element: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}

it("approves a pending proposal with the chosen option and comment", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.proposals.list.mockResolvedValue([
    proposal("p1", "pending", ["Fast", "Cheap"]),
    proposal("p2", "approved"),
  ]);
  api.proposals.decide.mockResolvedValue(proposal("p1", "approved"));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/app/approvals"]}>
        <ApprovalsPage />
      </MemoryRouter>,
    ),
  );

  const card = container.querySelector('[data-testid="proposal-p1"]');
  expect(card?.textContent).toContain("Plan p1");
  expect(container.querySelector('[data-testid="proposal-decided-p2"]')).not.toBeNull();

  await act(async () => {
    setFieldValue(card?.querySelector("select") as HTMLSelectElement, "Cheap");
    setFieldValue(card?.querySelector("textarea") as HTMLTextAreaElement, "Keep it under budget");
  });
  const approve = [...(card?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Approve",
  );
  await act(async () => approve?.click());

  expect(api.proposals.decide).toHaveBeenCalledWith({
    proposalId: "p1",
    decision: "approve",
    option: "Cheap",
    comment: "Keep it under budget",
  });
  await act(async () => root.unmount());
  container.remove();
});

 it("renders expired and stale proposals without decision controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.proposals.list.mockResolvedValue([proposal("expired", "expired"), proposal("stale", "stale")]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><ApprovalsPage /></MemoryRouter>));
    expect(container.querySelector('[data-testid="proposal-decided-expired"]')?.textContent).toContain("Expired");
    expect(container.querySelector('[data-testid="proposal-decided-stale"]')?.textContent).toContain("Stale");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
