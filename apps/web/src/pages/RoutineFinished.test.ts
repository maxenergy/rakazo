import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { routineFinished } from "./RoutineEditor";

const oneShot = {
  active: false,
  crons: ["@once"],
  lastRunAt: "2026-10-24T14:00:00.000Z",
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
};

describe("routineFinished", () => {
  it("treats a one-time routine that already ran as finished", () => {
    expect(routineFinished(oneShot)).toBe(true);
  });

  it("keeps paused recurring routines, unrun one-time routines and event triggers as not finished", () => {
    expect(routineFinished({ ...oneShot, crons: ["0 9 * * *"] })).toBe(false);
    expect(routineFinished({ ...oneShot, lastRunAt: null })).toBe(false);
    expect(routineFinished({ ...oneShot, active: true })).toBe(false);
    expect(routineFinished({ ...oneShot, webhookEnabled: true })).toBe(false);
  });
});
