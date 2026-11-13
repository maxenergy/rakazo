import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc, selectedSpaceId } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { ProjectFiles } from "./ProjectFiles";

export function ProjectWorkdir({ projectId }: { projectId: string }) {
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
    <section className="space-y-3" aria-label="项目工作目录">
      {error ? <p role="alert">{error}</p> : null}
      {binding === null ? <p>尚未绑定工作目录</p> : null}
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
            aria-label="工作目录相对路径"
            placeholder="shared/project/repo"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" disabled={saving || !draft.trim()}>
            绑定工作目录
          </Button>
        </form>
      ) : binding !== undefined ? (
        <Button onClick={() => setEditing(true)}>更改工作目录</Button>
      ) : null}
      {binding !== undefined && binding !== null ? (
        <ProjectFiles key={`${projectId}:${binding}`} projectId={projectId} />
      ) : null}
    </section>
  );
}
