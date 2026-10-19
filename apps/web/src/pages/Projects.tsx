import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ProjectBudget } from "../components/ProjectBudget";
import { ProjectProgress } from "../components/ProjectProgress";
import { rpc } from "../lib/rpc";
import { useBoardRefresh } from "../lib/use-board-refresh";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

export function ProjectsPage() {
  const { t } = useLingui();
  const { projectId, milestoneId } = useParams();
  const [archived, setArchived] = useState(false);
  const load = useCallback(
    async (spaceId: string | null) => {
      const options = { context: { spaceId } };
      if (projectId) {
        const [project, milestones, milestone] = await Promise.all([
          rpc.projects.get({ id: projectId }, options),
          rpc.milestones.list({ projectId, archived }, options),
          milestoneId ? rpc.milestones.get({ id: milestoneId }, options) : Promise.resolve(null),
        ]);
        if (milestone && milestone.projectId !== projectId) throw new Error("Resource not found.");
        return { projects: [], project, milestones, milestone };
      }
      return {
        projects: await rpc.projects.list({ archived }, options),
        project: null,
        milestones: [],
        milestone: null,
      };
    },
    [projectId, milestoneId, archived],
  );
  const { data, error } = useBoardRefresh(load);
  const detail = data?.milestone ?? data?.project;

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Button
          variant="ghost"
          render={
            <Link
              to={milestoneId ? `/app/projects/${projectId}` : projectId ? "/app/projects" : "/app"}
            />
          }
        >
          <Trans>Back</Trans>
        </Button>
        <h1 className="min-w-0 flex-1 break-words font-medium">{detail?.name ?? t`Projects`}</h1>
        <Button variant="outline" render={<Link to="/app/tickets" />}>
          <Trans>Tickets</Trans>
        </Button>
      </header>
      <main className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(error)}
          </p>
        ) : null}
        {detail ? (
          <section className="min-w-0 space-y-3">
            {detail.description ? (
              <p className="whitespace-pre-wrap break-words">{detail.description}</p>
            ) : null}
            {detail.archived ? (
              <p className="text-sm text-muted-foreground">
                <Trans>Archived</Trans>
              </p>
            ) : null}
            <ProjectProgress progress={detail.progress} />
            <Button
              variant="outline"
              render={
                <Link
                  to={`/app/tickets?projectId=${encodeURIComponent(projectId!)}${milestoneId ? `&milestoneId=${encodeURIComponent(milestoneId)}` : ""}`}
                />
              }
            >
              <Trans>Tickets</Trans>
            </Button>
          </section>
        ) : null}
        {projectId && !milestoneId && data?.project?.id === projectId && !error ? (
          <ProjectBudget key={projectId} projectId={projectId} />
        ) : null}
        {!milestoneId ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.target.checked)}
              />
              <Trans>Archived</Trans>
            </label>
            {projectId ? (
              <h2 className="font-medium">
                <Trans>Milestones</Trans>
              </h2>
            ) : null}
            <ul className="min-w-0 space-y-3">
              {(projectId ? data?.milestones : data?.projects)?.map((item) => (
                <li key={item.id} className="min-w-0 space-y-2 rounded-md border p-3">
                  <Link
                    className="block break-words font-medium underline-offset-4 hover:underline"
                    to={
                      projectId
                        ? `/app/projects/${projectId}/milestones/${item.id}`
                        : `/app/projects/${item.id}`
                    }
                  >
                    {item.name}
                  </Link>
                  <ProjectProgress progress={item.progress} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </main>
    </div>
  );
}
