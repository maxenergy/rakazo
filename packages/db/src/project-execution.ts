import { ProjectLinkError } from "./project-links.js";

type ProjectExecutionReader = {
  project: {
    findFirst(input: {
      where: { id: string; spaceId: string };
    }): Promise<{ status?: string } | null>;
  };
};

/** Gate new execution by its project, never by the employee's other memberships.
 * Rows predating the incremental status migration are active.
 * Callers resolve ticket.projectId before calling; existing runs are not cancelled.
 */
export async function assertProjectExecutionAllowed(
  db: ProjectExecutionReader,
  spaceId: string,
  projectId: string | null | undefined,
): Promise<void> {
  if (projectId == null) return;
  const project = await db.project.findFirst({ where: { id: projectId, spaceId } });
  if (!project) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  if (project.status === "paused")
    throw new ProjectLinkError(
      "BAD_REQUEST",
      "Project is paused. Resume it before starting new execution.",
    );
}
