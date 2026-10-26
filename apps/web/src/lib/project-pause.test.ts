import { describe, expect, it } from "vitest";
import { nextProjectPauseStatus } from "./project-pause";

describe("project pause status action", () => {
  it("pauses active projects and resumes paused projects", () => {
    expect(nextProjectPauseStatus("active")).toBe("paused");
    expect(nextProjectPauseStatus("paused")).toBe("active");
  });
});
