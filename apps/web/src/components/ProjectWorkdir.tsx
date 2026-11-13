import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc, selectedSpaceId } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { ProjectFiles } from "./ProjectFiles";

export function ProjectWorkdir({ projectId }: { projectId: string }) {
  const { t } = useLingui();
  const [binding, setBinding] = useState<string | null>();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spaceId = selectedSpaceId();
  useEffect(() => {
    let cancelled = false;
    setBinding(undefined);
    setError(null);
    void rpc.projects.workdir({ projectId }, { context: { spaceId } }).then(
      ({ path }) => {
        if (!cancelled) {
          setBinding(path);
          setDraft(path ?? "");
        }
      },
      (cause) => {
        if (!cancelled) setError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, spaceId]);
  return (
    <section id="project-files" className="space-y-3" aria-label={t`Project files`}>
      {error ? <p role="alert">{error}</p> : null}
      {binding === null ? (
        <p>
          <Trans>No working directory is bound</Trans>
        </p>
      ) : null}
      {binding !== undefined && (binding === null || editing) ? (
        <form
          className="flex gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving || !draft.trim()) return;
            setSaving(true);
            setError(null);
            try {
              await rpc.projects.update(
                { id: projectId, workdirPath: draft.trim() },
                { context: { spaceId } },
              );
              setBinding(draft.trim());
              setEditing(false);
            } catch (cause) {
              setError(errorText(cause));
            } finally {
              setSaving(false);
            }
          }}
        >
          <Input
            aria-label={t`Working directory relative path`}
            placeholder="shared/project/repo"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" disabled={saving || !draft.trim()}>
            <Trans>Bind working directory</Trans>
          </Button>
        </form>
      ) : binding !== undefined ? (
        <Button onClick={() => setEditing(true)}>{t`Change working directory`}</Button>
      ) : null}
      {binding !== undefined && binding !== null ? (
        <ProjectFiles key={`${projectId}:${binding}`} projectId={projectId} />
      ) : null}
    </section>
  );
}
