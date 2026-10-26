// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => text + (index > 0 ? String(values[index - 1]) : "") + part,
        "",
      ),
  }),
}));
vi.mock("../../lib/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { WorkLocationSection } from "./work-location";

let container: HTMLDivElement;
let root: Root;

function renderSection(canEdit: boolean, onSave = vi.fn(async () => {})) {
  act(() => {
    root.render(
      <WorkLocationSection
        location="container"
        effectiveLocation="container"
        hostRoots={[]}
        grantedAt={null}
        grantedBy={null}
        canEdit={canEdit}
        audit={[]}
        hasMoreAudit={false}
        auditError={null}
        validationError={null}
        onSave={onSave}
        onLoadMoreAudit={async () => {}}
      />,
    );
  });
  return onSave;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkLocationSection", () => {
  it("shows read-only effective location without edit controls to non-owners", () => {
    renderSection(false);
    expect(container.textContent).toContain("Effective location: Container");
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("requires confirmation and saves host roots for owners", async () => {
    const onSave = renderSection(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const select = container.querySelector("select");
    if (!select) throw new Error("Missing work location selector");
    await act(async () => {
      select.value = "host";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save work location")
        ?.click();
    });
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith({ workLocation: "host", hostRoots: [] });
  });

  it("renders backend validation errors", () => {
    act(() => {
      root.render(
        <WorkLocationSection
          location="host"
          effectiveLocation="host"
          hostRoots={["C:\\workspace"]}
          grantedAt="2026-10-26T00:00:00.000Z"
          grantedBy="Owner"
          canEdit
          audit={[]}
          hasMoreAudit
          auditError={null}
          validationError="UNC paths are not allowed"
          onSave={async () => {}}
          onLoadMoreAudit={async () => {}}
        />,
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "UNC paths are not allowed",
    );
    expect(container.textContent).toContain("Host audit");
    expect(container.textContent).toContain("Authorized 2026-10-26T00:00:00.000Z by Owner");
  });
});
