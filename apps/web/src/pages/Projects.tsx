import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ProjectBudget } from "../components/ProjectBudget";
import { ProjectGoals } from "../components/ProjectGoals";
import { ProjectMembers } from "../components/ProjectMembers";
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
        const [project, milestones, milestone, members, bots] = await Promise.all([
          rpc.projects.get({ id: projectId }, options),
          rpc.milestones.list({ projectId, archived }, options),
          milestoneId ? rpc.milestones.get({ id: milestoneId }, options) : Promise.resolve(null),
          rpc.projects.members({ projectId }, options),
          rpc.bots.list(undefined, options),
        ]);
        if (milestone && milestone.projectId !== projectId) throw new Error("Resource not found.");
        return { projects: [], project, milestones, milestone, members, bots };
      }
      const [projects, bots] = await Promise.all([
        rpc.projects.list({ archived }, options),
        rpc.bots.list(undefined, options),
      ]);
      return { projects, bots, project: null, milestones: [], milestone: null, members: [] };
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
            {data?.project && !milestoneId ? (
              <p className="text-sm text-muted-foreground">
                {data.project.status === "paused" ? <Trans>Paused</Trans> : <Trans>Active</Trans>}
                {data.project.owner ? (
                  ` | ${data.bots?.find((bot) => bot.id === data.project?.owner?.botId)?.name ?? data.project.owner.botId}`
                ) : (
                  <>
                    <span> | </span>
                    <Trans>No project owner assigned.</Trans>
                  </>
                )}
              </p>
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
                  to={`/app/tickets?projectId=${encodeURIComponent(projectId!)}${
                    milestoneId ? (
                      `&milestoneId=${encodeURIComponent(milestoneId)}`
                    ) : (
                      <>
                        <span> | </span>
                        <Trans>No project owner assigned.</Trans>
                      </>
                    )
                  }`}
                />
              }
            >
              <Trans>Tickets</Trans>
            </Button>
          </section>
        ) : null}
        {projectId && !milestoneId && data?.project?.id === projectId && !error ? (
          <ProjectBudget key={`budget:${projectId}`} projectId={projectId} />
        ) : null}
        {projectId && data?.project && !milestoneId && data.members && data.bots ? (
          <ProjectMembers
            members={data.members.map((member) => ({
              botId: member.botId,
              role: member.role,
              name: data.bots.find((bot) => bot.id === member.botId)?.name ?? member.botId,
            }))}
            people={data.bots.map((bot) => ({ botId: bot.id, name: bot.name }))}
            pending={data.project.archived}
            onAdd={async (botId) => {
              await rpc.projects.addMember({ projectId, botId });
            }}
            onRemove={async (botId) => {
              await rpc.projects.removeMember({ projectId, botId });
            }}
            onSetOwner={async (botId) => {
              await rpc.projects.setOwner({ projectId, botId });
            }}
          />
        ) : null}
        {projectId && data?.project && !milestoneId ? (
          <ProjectGoals
            key={`goals:${projectId}`}
            projectId={projectId}
            readOnly={data.project.archived}
          />
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
                  {"status" in item ? (
                    <p className="text-sm text-muted-foreground">
                      {item.status === "paused" ? <Trans>Paused</Trans> : <Trans>Active</Trans>}
                      {item.owner ? (
                        ` | ${data?.bots?.find((bot) => bot.id === item.owner?.botId)?.name ?? item.owner.botId}`
                      ) : (
                        <>
                          <span> | </span>
                          <Trans>No project owner assigned.</Trans>
                        </>
                      )}
                    </p>
                  ) : null}
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
