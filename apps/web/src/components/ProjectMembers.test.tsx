// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { ProjectMembers } from "./ProjectMembers";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function mount(props: Partial<ComponentProps<typeof ProjectMembers>> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onRemove = vi.fn().mockResolvedValue(undefined);
  const onSetOwner = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <ProjectMembers
        members={[
          { botId: "bot-owner", name: "Owner Bot", role: "owner", status: "active", model: null },
          { botId: "bot-member", name: "Member Bot", role: "member", status: "archived", model: "openai/model" },
        ]}
        people={[
          { botId: "bot-owner", name: "Owner Bot" },
          { botId: "bot-member", name: "Member Bot" },
          { botId: "bot-new", name: "New Bot" },
        ]}
        onAdd={onAdd}
        onRemove={onRemove}
        onSetOwner={onSetOwner}
        {...props}
      />,
    ),
  );
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, onAdd, onRemove, onSetOwner };
}

it("shows the assigned owner and lets a member become owner", async () => {
  const { container, onSetOwner } = await mount();
  expect(container.textContent).toContain("Owner Bot");
  expect(container.textContent).toContain("Owner");
  expect(container.textContent).toContain("Archived");
  expect(container.textContent).toContain("openai/model");
  const setOwnerButton = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Set owner"),
  )!;
  await act(async () => setOwnerButton.click());
  expect(onSetOwner).toHaveBeenCalledWith("bot-member");
});

it("allows clearing the current owner", async () => {
  const { container, onSetOwner } = await mount();
  const clearOwnerButton = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Clear owner"),
  )!;
  await act(async () => clearOwnerButton.click());
  expect(onSetOwner).toHaveBeenCalledWith(null);
});

it("shows the unassigned state", async () => {
  const { container } = await mount({
    members: [{ botId: "bot-member", name: "Member Bot", role: "member", status: "active", model: null }],
  });
  expect(container.textContent).toContain("No project owner assigned.");
});

it("adds only people who are not already members", async () => {
  const { container, onAdd } = await mount();
  const select = container.querySelector("select")!;
  expect([...select.options].map((option) => option.value)).toEqual(["", "bot-new"]);
  await act(async () => {
    select.value = "bot-new";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const form = container.querySelector("form")!;
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(onAdd).toHaveBeenCalledWith("bot-new");
});

it("disables member changes while a request is pending", async () => {
  const { container } = await mount({ pending: true });
  expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  expect(container.querySelector("select")?.disabled).toBe(true);
});
