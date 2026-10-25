// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  function View(props: { children?: ReactNode }) {
    return createElement("section", null, props.children);
  }
  function Text(props: { children?: ReactNode }) {
    return createElement("span", null, props.children);
  }
  return { StyleSheet: { create: <T,>(styles: T) => styles }, Text, View };
});
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (value: string) => value }) }));
vi.mock("../lib/native", () => ({
  useMobileTokens: () => ({ card: "card", foreground: "foreground", mutedForeground: "muted" }),
}));

import { ProjectMembersReadOnly } from "../components/ProjectMembersReadOnly";

describe("ProjectMembersReadOnly", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  it("shows member roles and directs edits to web", () => {
    act(() =>
      root?.render(
        <ProjectMembersReadOnly
          members={[
            {
              botId: "owner",
              name: "Owner Bot",
              role: "owner",
              status: "archived",
              model: "anthropic/claude",
            },
            { botId: "member", name: "Member Bot", role: "member", status: "active", model: null },
          ]}
        />,
      ),
    );
    expect(container?.textContent).toContain("Owner Bot");
    expect(container?.textContent).toContain("Archived");
    expect(container?.textContent).toContain("anthropic/claude");
    expect(container?.textContent).toContain("Member");
    expect(container?.textContent).toContain("Manage project members on web.");
  });

  it("shows an empty state without edit controls", () => {
    act(() => root?.render(<ProjectMembersReadOnly members={[]} />));
    expect(container?.textContent).toContain("No members yet.");
    expect(container?.querySelector("button")).toBeNull();
  });
});
