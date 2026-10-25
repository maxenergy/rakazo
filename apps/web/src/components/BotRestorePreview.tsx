import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import type { Routine } from "@rakazo/contracts";
import { useState } from "react";

export type RestorePreview = {
  projects: { id: string; name: string; status: "active" | "paused"; archivedAt: string | null; member: boolean }[];
  tickets: { id: string; projectId: string | null; title: string; status: string }[];
  routines: Routine[];
};

export function BotRestorePreview({
  botName,
  preview,
  pending = false,
  onCancel,
  onConfirmRestore,
  onEnableRoutine,
}: {
  botName: string;
  preview: RestorePreview;
  pending?: boolean;
  onCancel: () => void;
  onConfirmRestore: () => Promise<void>;
  onEnableRoutine: (routineId: string) => Promise<void>;
}) {
  const [routineError, setRoutineError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pausedProjects = new Set(preview.projects.filter((project) => project.status === "paused").map((project) => project.id));
  return (
    <section role="dialog" aria-modal="true" aria-labelledby="restore-preview-title" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-xl space-y-4 overflow-y-auto rounded-lg border bg-background p-5 text-foreground shadow-lg">
        <h2 id="restore-preview-title" className="text-lg font-semibold"><Trans>Restore preview</Trans>: {botName}</h2>
        <section className="space-y-2">
          <h3 className="font-medium"><Trans>Projects</Trans></h3>
          {preview.projects.map((project) => (
            <p key={project.id} className="text-sm">
              {project.name} · {project.status === "paused" ? <Trans>Paused</Trans> : <Trans>Active</Trans>} · {project.member ? <Trans>Member</Trans> : <Trans>Not a member</Trans>}
            </p>
          ))}
        </section>
        <section className="space-y-2">
          <h3 className="font-medium"><Trans>Unfinished tickets</Trans></h3>
          {preview.tickets.length ? preview.tickets.map((ticket) => (
            <p key={ticket.id} className="text-sm">
              {ticket.title} · {preview.projects.find((project) => project.id === ticket.projectId)?.name ?? <Trans>No project</Trans>} · {ticket.status}
            </p>
          )) : <p className="text-sm text-muted-foreground"><Trans>No unfinished tickets.</Trans></p>}
        </section>
        <section className="space-y-2">
          <h3 className="font-medium"><Trans>Disabled routines</Trans></h3>
          {preview.routines.length ? preview.routines.map((routine) => {
            const paused = routine.projectId ? pausedProjects.has(routine.projectId) : false;
            return (
              <div key={routine.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-words text-sm">
                  {routine.name} · {preview.projects.find((project) => project.id === routine.projectId)?.name ?? <Trans>No project</Trans>}
                </span>
                {paused ? <span className="text-sm text-muted-foreground"><Trans>Project paused</Trans></span> : null}
                <Button type="button" variant="outline" disabled={pending || busy || paused || routine.active} onClick={() => {
                    setRoutineError(null);
                    setBusy(true);
                    void onEnableRoutine(routine.id).catch((cause: unknown) => setRoutineError(String(cause))).finally(() => setBusy(false));
                  }}>
                  {routine.active ? <Trans>Enabled</Trans> : <Trans>Enable</Trans>}
                </Button>
              </div>
            );
          }) : <p className="text-sm text-muted-foreground"><Trans>No disabled routines.</Trans></p>}
        </section>
        {routineError ? <p role="alert" className="text-sm text-destructive">{routineError}</p> : null}
        <p className="text-sm text-muted-foreground"><Trans>Routines stay disabled until enabled individually.</Trans></p>
        <p className="text-sm text-muted-foreground"><Trans>Historical runs stay with their original project.</Trans></p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending || busy} onClick={onCancel}><Trans>Cancel</Trans></Button>
          <Button type="button" disabled={pending || busy} onClick={() => {
            setRoutineError(null);
            setBusy(true);
            void onConfirmRestore().catch((cause: unknown) => setRoutineError(String(cause))).finally(() => setBusy(false));
          }}><Trans>Restore employee</Trans></Button>
        </div>
      </div>
    </section>
  );
}
