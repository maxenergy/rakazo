import { Trans } from "@lingui/react/macro";
import { Link } from "react-router-dom";

export function MilestoneArtifactsLink({ milestoneId }: { milestoneId: string }) {
  return (
    <Link
      className="inline-flex min-h-11 items-center rounded-md border px-3 py-2 text-sm underline-offset-4 hover:bg-accent hover:underline"
      to={`/artifacts?milestoneId=${encodeURIComponent(milestoneId)}`}
    >
      <Trans>View artifacts</Trans>
    </Link>
  );
}
