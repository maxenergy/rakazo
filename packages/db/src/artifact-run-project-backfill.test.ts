import { describe, expect, it } from "vitest";
import type { HistoricalArtifact, HistoricalRunProject } from "./artifact-backfill.js";
import { planArtifactRunProjectBackfill } from "./artifact-backfill.js";

const artifact: HistoricalArtifact = {
  id: "artifact",
  spaceId: "space",
  name: "report",
  description: null,
  projectId: null,
  milestoneId: null,
  ticketId: null,
  linkSource: null,
};
const run: HistoricalRunProject = {
  runSpaceId: "space",
  runProjectId: "project",
  projectSpaceId: "space",
};
describe("run project artifact backfill", () => {
  it("fills only project and source from the run", () => {
    expect(planArtifactRunProjectBackfill(artifact, [], run)).toEqual({
      kind: "matched",
      links: {
        projectId: "project",
        milestoneId: null,
        ticketId: null,
        linkSource: "backfill_run_project",
      },
    });
  });
  it.each(["projectId", "milestoneId", "ticketId", "linkSource"] as const)(
    "preserves an existing %s",
    (field) => {
      expect(planArtifactRunProjectBackfill({ ...artifact, [field]: "existing" }, [], run)).toEqual(
        { kind: "skipped", reason: "existing_links" },
      );
    },
  );
  it.each([
    [{ ...run, runSpaceId: null }, "run_not_found"],
    [{ ...run, runSpaceId: "other" }, "run_space_mismatch"],
    [{ ...run, runProjectId: null }, "run_without_project"],
    [{ ...run, projectSpaceId: null }, "project_not_found"],
    [{ ...run, projectSpaceId: "other" }, "project_space_mismatch"],
  ] as const)("skips invalid run ownership %#", (ownership, reason) => {
    expect(planArtifactRunProjectBackfill(artifact, [], ownership)).toEqual({
      kind: "skipped",
      reason,
    });
  });
  it("retains ticket precedence over run project", () => {
    expect(
      planArtifactRunProjectBackfill(
        { ...artifact, name: "RAK-170" },
        [
          {
            id: "ticket",
            spaceId: "space",
            number: 170,
            projectId: "ticket-project",
            milestoneId: "milestone",
            valid: true,
          },
        ],
        run,
      ),
    ).toEqual({
      kind: "matched",
      links: {
        projectId: "ticket-project",
        milestoneId: "milestone",
        ticketId: "ticket",
        linkSource: "backfill",
      },
    });
  });
  it("does not bypass ambiguous or missing ticket references", () => {
    expect(
      planArtifactRunProjectBackfill({ ...artifact, name: "RAK-170 RAK-171" }, [], run),
    ).toEqual({ kind: "ambiguous", reason: "multiple_references" });
    expect(planArtifactRunProjectBackfill({ ...artifact, name: "RAK-170" }, [], run)).toEqual({
      kind: "unmatched",
      reason: "ticket_not_found",
    });
  });
});
