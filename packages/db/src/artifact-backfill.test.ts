import { describe, expect, it } from "vitest";
import type { HistoricalArtifact, HistoricalTicket } from "./artifact-backfill.js";
import { planArtifactBackfill } from "./artifact-backfill.js";

const artifact: HistoricalArtifact = {
  id: "artifact",
  spaceId: "space",
  name: "RAK-170 report",
  description: null,
  projectId: null,
  milestoneId: null,
  ticketId: null,
  linkSource: null,
};
const ticket: HistoricalTicket = {
  id: "ticket",
  spaceId: "space",
  number: 170,
  projectId: "project",
  milestoneId: "milestone",
  valid: true,
};

describe("historical artifact links", () => {
  it("matches one reference repeated across name and description", () => {
    expect(planArtifactBackfill({ ...artifact, description: "RAK-170" }, [ticket])).toEqual({
      kind: "matched",
      links: {
        projectId: "project",
        milestoneId: "milestone",
        ticketId: "ticket",
        linkSource: "backfill",
      },
    });
  });
  it("accepts a reference in a Chinese description", () => {
    expect(
      planArtifactBackfill({ ...artifact, name: "报告", description: "完成RAK-170。" }, [ticket])
        .kind,
    ).toBe("matched");
  });
  it("leaves multiple distinct references ambiguous", () => {
    expect(planArtifactBackfill({ ...artifact, description: "RAK-171" }, [ticket])).toEqual({
      kind: "ambiguous",
      reason: "multiple_references",
    });
  });
  it.each(["RAK-0170", "rak-170", "XRAK-170", "RAK-1700", "RAK-170x", "nothing"])(
    "does not infer a match from %s",
    (name) => {
      expect(planArtifactBackfill({ ...artifact, name }, [ticket]).kind).toBe("unmatched");
    },
  );
  it.each(["RAK-170-report.png", "report_RAK-170_preview.png"])(
    "matches a filename with separators: %s",
    (name) => {
      expect(planArtifactBackfill({ ...artifact, name }, [ticket]).kind).toBe("matched");
    },
  );
  it("never matches tickets from another space", () => {
    expect(planArtifactBackfill(artifact, [{ ...ticket, spaceId: "other" }])).toEqual({
      kind: "unmatched",
      reason: "ticket_not_found",
    });
  });
  it("rejects duplicate ticket candidates", () => {
    expect(planArtifactBackfill(artifact, [ticket, { ...ticket, id: "duplicate" }]).kind).toBe(
      "ambiguous",
    );
  });
  it("skips invalid ticket relationships", () => {
    expect(planArtifactBackfill(artifact, [{ ...ticket, valid: false }])).toEqual({
      kind: "skipped",
      reason: "invalid_ticket_links",
    });
  });
  it.each(["projectId", "milestoneId", "ticketId"] as const)(
    "preserves a conflicting %s and leaves missing fields empty",
    (key) => {
      expect(planArtifactBackfill({ ...artifact, [key]: "other" }, [ticket])).toEqual({
        kind: "skipped",
        reason: "existing_link_conflict",
      });
    },
  );
  it("fills only missing fields and preserves the existing source", () => {
    expect(
      planArtifactBackfill({ ...artifact, projectId: "project", linkSource: "explicit" }, [ticket]),
    ).toEqual({
      kind: "matched",
      links: {
        projectId: "project",
        milestoneId: "milestone",
        ticketId: "ticket",
        linkSource: "explicit",
      },
    });
  });
  it("is idempotent after applying a plan", () => {
    const result = planArtifactBackfill(artifact, [ticket]);
    if (result.kind !== "matched") throw new Error("Expected a match");
    expect(planArtifactBackfill({ ...artifact, ...result.links }, [ticket])).toEqual({
      kind: "skipped",
      reason: "already_linked",
    });
  });
  it("supports tickets without project or milestone", () => {
    expect(
      planArtifactBackfill(artifact, [{ ...ticket, projectId: null, milestoneId: null }]),
    ).toEqual({
      kind: "matched",
      links: { projectId: null, milestoneId: null, ticketId: "ticket", linkSource: "backfill" },
    });
  });
});
