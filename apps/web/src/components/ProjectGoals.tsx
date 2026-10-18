import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useCallback, useState } from "react";
import { rpc, selectedSpaceId } from "../lib/rpc";
import { useBoardRefresh } from "../lib/use-board-refresh";
import { errorText } from "../lib/user-error";
import { GoalEditor } from "./GoalEditor";

export function ProjectGoals({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const { t } = useLingui();
  const [milestones, setMilestones] = useState<{ id: string; name: string; archived: boolean }[]>(
    [],
  );
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  const [archived, setArchived] = useState(false);
  const [archivedResults, setArchivedResults] = useState(false);
  const load = useCallback(
    async (spaceId: string | null) => {
      const options = { context: { spaceId } };
      const [milestones, archivedMilestones] = await Promise.all([
        rpc.milestones.list({ projectId, archived: false }, options),
        rpc.milestones.list({ projectId, archived: true }, options),
      ]);
      if (selectedSpaceId() === spaceId) setMilestones(milestones);
      const goals = await rpc.goals.list({ projectId, archived }, options);
      return Promise.all(
        goals.map(async (goal) => ({
          goal,
          archivedMilestones,
          results: await rpc.keyResults.list(
            { goalId: goal.id, archived: archivedResults },
            options,
          ),
        })),
      );
    },
    [projectId, archived, archivedResults, revision],
  );
  const { data, error } = useBoardRefresh(load);
  async function mutate(
    action: (options: { context: { spaceId: string | null } }) => Promise<unknown>,
  ) {
    if (pending || readOnly) return;
    const spaceId = selectedSpaceId();
    setPending(true);
    setMutationError(undefined);
    try {
      await action({ context: { spaceId } });
      if (selectedSpaceId() === spaceId) setRevision((value) => value + 1);
    } catch (cause) {
      if (selectedSpaceId() === spaceId) setMutationError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="min-w-0 space-y-3" aria-labelledby="project-goals-title">
      <h2 id="project-goals-title" className="font-medium">
        <Trans>Goals</Trans>
      </h2>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => setArchived(event.target.checked)}
        />
        <Trans>Archived goals</Trans>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={archivedResults}
          onChange={(event) => setArchivedResults(event.target.checked)}
        />
        <Trans>Archived key results</Trans>
      </label>
      {!readOnly && !archived ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            const spaceId = selectedSpaceId();
            setPending(true);
            setMutationError(undefined);
            try {
              await rpc.goals.create({ projectId, name: name.trim() }, { context: { spaceId } });
              if (selectedSpaceId() === spaceId) {
                setName("");
                setRevision((value) => value + 1);
              }
            } catch (cause) {
              if (selectedSpaceId() === spaceId) setMutationError(cause);
            } finally {
              setPending(false);
            }
          }}
        >
          <Input
            aria-label={t`Goal name`}
            value={name}
            maxLength={200}
            required
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" disabled={pending || !name.trim()}>
            <Trans>Add goal</Trans>
          </Button>
        </form>
      ) : null}
      {mutationError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(mutationError)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(error)}
        </p>
      ) : null}
      {data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No goals</Trans>
        </p>
      ) : null}
      <ul className="space-y-3">
        {data?.map(({ goal, results, archivedMilestones }) => (
          <li key={goal.id} className="min-w-0 space-y-2 rounded-md border p-3">
            <h3 className="break-words font-medium">{goal.name}</h3>
            <p className="text-sm">{goal.state}</p>
            {goal.description ? (
              <p className="whitespace-pre-wrap break-words text-sm">{goal.description}</p>
            ) : null}
            {goal.dueAt ? <time dateTime={goal.dueAt}>{goal.dueAt.slice(0, 10)}</time> : null}
            {!readOnly && !goal.archived ? (
              <>
                <details>
                  <summary>
                    <Trans>Edit goal</Trans>
                  </summary>
                  <GoalEditor
                    initial={goal}
                    kind="goal"
                    pending={pending}
                    onSave={async (fields) => {
                      await mutate((options) =>
                        rpc.goals.update({ id: goal.id, ...fields }, options),
                      );
                    }}
                  />
                </details>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    window.confirm(t`Delete this goal and all its key results?`) &&
                    void mutate((options) => rpc.goals.delete({ id: goal.id }, options))
                  }
                >
                  <Trans>Delete goal</Trans>
                </Button>
                <details>
                  <summary>
                    <Trans>Add key result</Trans>
                  </summary>
                  <GoalEditor
                    kind="result"
                    pending={pending}
                    milestones={milestones}
                    onSave={async (fields) => {
                      if (!("measure" in fields)) return;
                      await mutate((options) =>
                        rpc.keyResults.create({ goalId: goal.id, ...fields }, options),
                      );
                    }}
                  />
                </details>
              </>
            ) : null}
            <ul className="space-y-2">
              {results.map((result) => (
                <li key={result.id} className="min-w-0 space-y-1 border-t pt-2">
                  <h4 className="break-words">{result.name}</h4>
                  <p className="break-words text-sm">
                    {result.currentValue} / {result.targetValue} {result.measure}
                  </p>
                  {Number.isFinite(result.currentValue) &&
                  Number.isFinite(result.targetValue) &&
                  result.targetValue !== 0 ? (
                    <progress
                      aria-label={t`Key result progress`}
                      max={100}
                      value={Math.max(
                        0,
                        Math.min(100, (result.currentValue / result.targetValue) * 100),
                      )}
                    />
                  ) : (
                    <p>
                      <Trans>No data</Trans>
                    </p>
                  )}
                  {result.dueAt &&
                  Date.parse(result.dueAt) < Date.now() &&
                  result.state !== "achieved" &&
                  result.state !== "cancelled" ? (
                    <p className="text-sm text-destructive">
                      <Trans>Overdue</Trans>
                    </p>
                  ) : null}
                  <p className="text-sm">{result.state}</p>
                  {!readOnly &&
                  !goal.archived &&
                  !result.archived &&
                  !archivedMilestones.some((milestone) => milestone.id === result.milestoneId) ? (
                    <details>
                      <summary>
                        <Trans>Edit key result</Trans>
                      </summary>
                      <GoalEditor
                        initial={result}
                        kind="result"
                        pending={pending}
                        milestones={milestones}
                        onSave={async (fields) => {
                          if (!("measure" in fields)) return;
                          await mutate((options) =>
                            rpc.keyResults.update({ id: result.id, ...fields }, options),
                          );
                        }}
                      />
                    </details>
                  ) : null}
                  {!readOnly && !goal.archived ? (
                    <div className="flex flex-wrap gap-2">
                      {!result.archived ? (
                        <Button
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            void mutate((options) =>
                              rpc.keyResults.archive({ id: result.id }, options),
                            )
                          }
                        >
                          <Trans>Archive key result</Trans>
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          window.confirm(t`Delete this key result?`) &&
                          void mutate((options) =>
                            rpc.keyResults.delete({ id: result.id }, options),
                          )
                        }
                      >
                        <Trans>Delete key result</Trans>
                      </Button>
                    </div>
                  ) : null}
                  {result.dueAt ? (
                    <time dateTime={result.dueAt}>{result.dueAt.slice(0, 10)}</time>
                  ) : null}
                  {result.milestoneId ? (
                    <p className="break-words text-sm">
                      {milestones.find((item) => item.id === result.milestoneId)?.name ?? (
                        <Trans>Archived milestone</Trans>
                      )}
                    </p>
                  ) : null}
                  <details className="text-sm">
                    <summary>
                      <Trans>Calculation rule</Trans>
                    </summary>
                    <p className="whitespace-pre-wrap break-words">{result.calculationRule}</p>
                  </details>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
