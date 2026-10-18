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
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { GoalEditor } from "./GoalEditor";

const initial = {
  id: "kr-one",
  name: "Revenue",
  description: null,
  state: "active",
  dueAt: null,
  measure: "USD",
  currentValue: 120,
  targetValue: 100,
  calculationRule: "Recorded revenue",
  milestoneId: "old-milestone",
} as NonNullable<ComponentProps<typeof GoalEditor>["initial"]>;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});
async function mount(pending = false, activeMilestone = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSave = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <GoalEditor
        kind="result"
        initial={initial}
        pending={pending}
        milestones={
          activeMilestone
            ? [{ id: "old-milestone", name: "Active milestone", archived: false }]
            : []
        }
        onSave={onSave}
      />,
    ),
  );
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, onSave };
}
it("preserves explicit active state when current value exceeds target", async () => {
  const { container, onSave } = await mount(false, true);
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      state: "active",
      currentValue: 120,
      targetValue: 100,
      calculationRule: "Recorded revenue",
    }),
  );
});
it("allows unlinking an archived milestone explicitly", async () => {
  const { container, onSave } = await mount();
  const select = [...container.querySelectorAll("select")].find((item) =>
    [...item.options].some((option) => option.value === "old-milestone"),
  )!;
  expect(select.querySelector<HTMLOptionElement>('option[value="old-milestone"]')?.disabled).toBe(
    true,
  );
  await act(async () => {
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ milestoneId: null, state: "active" }),
  );
});
it("disables editing and rejects submission while a mutation is pending", async () => {
  const { container, onSave } = await mount(true);
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(onSave).not.toHaveBeenCalled();
});

it("blocks saving until an archived milestone is cleared or replaced", async () => {
  const { container, onSave } = await mount();
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(container.textContent).toContain("Clear or replace the archived milestone before saving.");
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(onSave).not.toHaveBeenCalled();
});
