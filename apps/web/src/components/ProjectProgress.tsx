import { Trans, useLingui } from "@lingui/react/macro";
import type { ProjectProgress as Progress } from "@rakazo/contracts";

export function ProjectProgress({ progress }: { progress: Progress }) {
  const { t } = useLingui();
  const { completed, total } = progress;
  return (
    <div className="min-w-0 space-y-1 text-sm text-muted-foreground">
      <p>
        {completed}/{total} · {total === 0 ? <Trans>No tickets yet</Trans> : <Trans>Ended</Trans>}
      </p>
      {total > 0 ? (
        <progress
          aria-label={t`Ended`}
          className="h-1 w-full accent-primary"
          value={completed}
          max={total}
        />
      ) : null}
    </div>
  );
}
