import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { errorText } from "../../lib/user-error";

export type WorkLocation = "container" | "host";

export type HostAuditEntry = {
  id: string;
  createdAt: string;
  kind:
    | "exec"
    | "file.write"
    | "file.delete"
    | "grant"
    | "revoke"
    | "location_switch"
    | "file_transfer";
  target: string;
  exitCode: number | null;
};

export function WorkLocationSection({
  location,
  effectiveLocation,
  hostRoots,
  grantedAt,
  grantedBy,
  canEdit,
  audit,
  hasMoreAudit,
  auditError,
  validationError,
  onSave,
  onLoadMoreAudit,
}: {
  location: WorkLocation;
  effectiveLocation: WorkLocation | "this-mac";
  hostRoots: string[];
  grantedAt: string | null;
  grantedBy: string | null;
  canEdit: boolean;
  audit: HostAuditEntry[];
  hasMoreAudit: boolean;
  auditError: string | null;
  validationError: string | null;
  onSave: (input: { workLocation: WorkLocation; hostRoots: string[] }) => Promise<void>;
  onLoadMoreAudit: () => Promise<void>;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [draftLocation, setDraftLocation] = useState(location);
  const [draftRoots, setDraftRoots] = useState(hostRoots);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auditMoreError, setAuditMoreError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    const changed =
      draftLocation !== location ||
      draftRoots.length !== hostRoots.length ||
      draftRoots.some((root, index) => root !== hostRoots[index]);
    if (
      changed &&
      !window.confirm(
        t`Changing work location can allow irreversible operations on the host. Continue?`,
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        workLocation: draftLocation,
        hostRoots: draftLocation === "host" ? draftRoots : [],
      });
    } catch (cause) {
      setError(errorText(cause, t`Could not save work location`));
    } finally {
      setSaving(false);
    }
  }

  async function loadMoreAudit() {
    setAuditMoreError(null);
    try {
      await onLoadMoreAudit();
    } catch (cause) {
      setAuditMoreError(errorText(cause, t`Could not load host audit`));
    }
  }

  return (
    <section aria-labelledby={`${ids}-heading`} className="mt-5 border-t border-border pt-4">
      <h3 id={`${ids}-heading`} className="text-[14px] font-medium">
        <Trans>Work location</Trans>
      </h3>
      <p className="mt-2 text-[13px] text-muted-foreground">
        <Trans>Effective location:</Trans>{" "}
        {effectiveLocation === "this-mac" ? (
          <Trans>This Mac</Trans>
        ) : effectiveLocation === "host" ? (
          <Trans>Host</Trans>
        ) : (
          <Trans>Container</Trans>
        )}
      </p>
      {canEdit ? (
        <>
          <label
            htmlFor={`${ids}-location`}
            className="mt-3 block text-[14px] text-muted-foreground"
          >
            <Trans>Location</Trans>
          </label>
          <NativeSelect
            id={`${ids}-location`}
            className="mt-1.5 w-full"
            value={draftLocation}
            onChange={(event) => setDraftLocation(event.target.value as WorkLocation)}
          >
            <NativeSelectOption value="container">
              <Trans>Container</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="host">
              <Trans>Host</Trans>
            </NativeSelectOption>
          </NativeSelect>
          {draftLocation === "host" ? (
            <fieldset className="mt-3 space-y-2">
              <legend className="text-[14px] text-muted-foreground">
                <Trans>Host directories (up to 10)</Trans>
              </legend>
              {draftRoots.map((root, index) => (
                <div key={index} className="space-y-1">
                  <label
                    htmlFor={`${ids}-root-${index}`}
                    className="text-[13px] text-muted-foreground"
                  >
                    <Trans>Host directory {index + 1}</Trans>
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`${ids}-root-${index}`}
                      value={root}
                      onChange={(event) =>
                        setDraftRoots((current) =>
                          current.map((entry, item) =>
                            item === index ? event.target.value : entry,
                          ),
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t`Remove directory`}
                      onClick={() =>
                        setDraftRoots((current) => current.filter((_, item) => item !== index))
                      }
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  </div>
                </div>
              ))}
              {draftRoots.length < 10 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDraftRoots((current) => [...current, ""])}
                >
                  <Trans>Add directory</Trans>
                </Button>
              ) : null}
            </fieldset>
          ) : null}
          <Button className="mt-3" disabled={saving} onClick={() => void save()}>
            <Trans>Save work location</Trans>
          </Button>
        </>
      ) : (
        <p className="mt-2 text-[14px] text-muted-foreground">
          {location === "host" ? <Trans>Host</Trans> : <Trans>Container</Trans>}
        </p>
      )}
      <p className="mt-2 text-[13px] text-muted-foreground">
        {grantedAt ? (
          <Trans>
            Authorized {grantedAt} by {grantedBy}
          </Trans>
        ) : (
          <Trans>No host authorization</Trans>
        )}
      </p>
      {error || validationError ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {validationError ?? error}
        </p>
      ) : null}
      {canEdit ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-[14px]">
            <Trans>Host audit</Trans>
          </summary>
          {auditMoreError || auditError ? (
            <p role="alert" className="mt-2 text-[13px] text-destructive">
              {auditMoreError ?? auditError}
            </p>
          ) : null}
          {audit.length === 0 ? (
            <p className="mt-2 text-[13px] text-muted-foreground">
              <Trans>No host audit entries</Trans>
            </p>
          ) : null}
          <ul className="mt-2 divide-y divide-border">
            {audit.map((entry) => (
              <li key={entry.id} className="py-2 text-[13px]">
                <span>
                  {entry.createdAt} · <AuditKind kind={entry.kind} /> · {entry.target} ·{" "}
                </span>
                {entry.exitCode === null ? (
                  <Trans>—</Trans>
                ) : (
                  <Trans>Exit code {entry.exitCode}</Trans>
                )}
              </li>
            ))}
          </ul>
          {hasMoreAudit ? (
            <Button variant="ghost" size="sm" onClick={() => void loadMoreAudit()}>
              <Trans>Load more</Trans>
            </Button>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

function AuditKind({ kind }: { kind: HostAuditEntry["kind"] }) {
  switch (kind) {
    case "exec":
      return <Trans>Host command</Trans>;
    case "file.write":
      return <Trans>File write</Trans>;
    case "file.delete":
      return <Trans>File delete</Trans>;
    case "location_switch":
      return <Trans>Work location switch</Trans>;
    case "file_transfer":
      return <Trans>File transfer</Trans>;
    case "grant":
      return <Trans>Host access granted</Trans>;
    case "revoke":
      return <Trans>Host access revoked</Trans>;
  }
}
