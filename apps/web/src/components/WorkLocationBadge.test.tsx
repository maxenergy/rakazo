import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { WorkLocationBadge } from "./WorkLocationBadge";

describe("WorkLocationBadge", () => {
  it.each([
    ["host", "Host"],
    ["this-mac", "This Mac"],
    ["container", "Container"],
  ] as const)("shows the execution location %s", (location, label) => {
    const html = renderToStaticMarkup(createElement(WorkLocationBadge, { location }));
    expect(html).toContain('data-testid="work-location-badge"');
    expect(html).toContain(label);
  });
});
