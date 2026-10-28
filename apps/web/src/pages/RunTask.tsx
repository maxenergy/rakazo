import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { RunDiagnostics } from "./RunDiagnostics";

export function RunTask({ runId }: { runId: string }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <details className="mx-3 mb-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted-foreground">{t`Run task`}</summary>
      {open ? <RunDiagnostics key={runId} runId={runId} /> : null}
    </details>
  );
}
