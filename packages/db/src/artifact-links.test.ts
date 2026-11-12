import { describe, expect, it, vi } from "vitest";
import { resolveArtifactLinks } from "./artifact-links.js";
import type { Prisma } from "./client.js";

function database() {
  const ticket = vi
    .fn()
    .mockImplementation(async ({ where }) =>
      where.spaceId === "space" && (where.id === "ticket" || where.number === 17)
        ? { id: "ticket", projectId: "project", milestoneId: "milestone" }
        : null,
    );
  const db = {
    ticket: { findFirst: ticket },
    project: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.id === "project" && where.spaceId === "space" ? { id: "project" } : null,
        ),
    },
    milestone: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }) =>
          where.id === "milestone" && where.spaceId === "space" ? { projectId: "project" } : null,
        ),
    },
  };
  return { db: db as unknown as Prisma.TransactionClient, ticket };
}

describe("artifact associations", () => {
  it("resolves an explicit ticket reference within the space", async () => {
    const { db, ticket } = database();
    await expect(resolveArtifactLinks(db, "space", { ticketRef: "RAK-17" })).resolves.toEqual({
      projectId: "project",
      milestoneId: "milestone",
      ticketId: "ticket",
      linkSource: "explicit",
    });
    expect(ticket).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space", number: 17, board: { ticketPrefix: "RAK" } },
      }),
    );
  });

  it("automatically derives all links from trusted run ticket context", async () => {
    const { db } = database();
    await expect(
      resolveArtifactLinks(
        db,
        "space",
        {},
        {
          projectId: "project",
          ticketId: "ticket",
        },
      ),
    ).resolves.toEqual({
      projectId: "project",
      milestoneId: "milestone",
      ticketId: "ticket",
      linkSource: "run",
    });
  });

  it("keeps legacy uploads unassociated without looking up assignments", async () => {
    const { db, ticket } = database();
    await expect(resolveArtifactLinks(db, "space", {})).resolves.toEqual({
      projectId: null,
      milestoneId: null,
      ticketId: null,
      linkSource: null,
    });
    expect(ticket).not.toHaveBeenCalled();
  });

  it("rejects tickets, projects and milestones from another space", async () => {
    const { db } = database();
    for (const links of [
      { ticketId: "ticket" },
      { ticketRef: "RAK-17" },
      { projectId: "project" },
      { projectId: "project", milestoneId: "milestone" },
    ]) {
      await expect(resolveArtifactLinks(db, "other-space", links)).rejects.toThrow("conflicts");
    }
  });

  it("rejects explicit or run links that conflict with the ticket", async () => {
    const { db } = database();
    for (const links of [
      { ticketId: "ticket", projectId: "other" },
      { ticketId: "ticket", milestoneId: "other" },
      { projectId: "other", milestoneId: "milestone" },
    ]) {
      await expect(resolveArtifactLinks(db, "space", links)).rejects.toThrow("conflicts");
    }
    await expect(
      resolveArtifactLinks(
        db,
        "space",
        { ticketId: "other" },
        {
          projectId: "project",
          ticketId: "ticket",
        },
      ),
    ).rejects.toThrow("conflicts");
    await expect(
      resolveArtifactLinks(
        db,
        "space",
        { ticketId: "ticket" },
        {
          projectId: null,
        },
      ),
    ).rejects.toThrow("conflicts");
  });
  it("keeps automatic uploads when ticket context is missing or invalid", async () => {
    const { db } = database();
    for (const context of [
      { projectId: "project", ticketId: null },
      { projectId: "other", ticketId: "ticket" },
      { projectId: "project", ticketId: "outside" },
    ]) {
      await expect(resolveArtifactLinks(db, "space", {}, context)).resolves.toEqual({
        projectId: null,
        milestoneId: null,
        ticketId: null,
        linkSource: null,
      });
    }
  });
});
