// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({ Trans: ({ children }: { children: ReactNode }) => children }));
vi.mock("@rakazo/ui-web", () => ({ Button: (props: ComponentProps<"button">) => <button {...props} /> }));

import { BotRestorePreview } from "./BotRestorePreview";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

it("does not restore until the preview is explicitly confirmed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onRestore = vi.fn().mockResolvedValue(undefined);
  const onEnableRoutine = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(
    <BotRestorePreview
      botName="Restored bot"
      preview={{ projects: [], tickets: [], routines: [] }}
      onCancel={() => undefined}
      onConfirmRestore={onRestore}
      onEnableRoutine={onEnableRoutine}
    />,
  ));
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  expect(onRestore).not.toHaveBeenCalled();
  const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Restore employee"))!;
  await act(async () => confirm.click());
  expect(onRestore).toHaveBeenCalledOnce();
});
