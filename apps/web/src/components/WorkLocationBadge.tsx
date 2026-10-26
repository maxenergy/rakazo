import { Trans } from "@lingui/react/macro";

export type WorkLocation = "host" | "this-mac" | "container";

export function WorkLocationBadge({ location }: { location: WorkLocation }) {
  return (
    <span
      className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
      data-testid="work-location-badge"
    >
      {location === "host" ? (
        <Trans>Host</Trans>
      ) : location === "this-mac" ? (
        <Trans>This Mac</Trans>
      ) : (
        <Trans>Container</Trans>
      )}
    </span>
  );
}
