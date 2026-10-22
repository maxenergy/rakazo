import type { RunDiagnosticsOutput } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

type Section = "attempts" | "events" | "effects" | "usage";
export function RunDiagnostics({ runId }: { runId: string }) {
  const [section, setSection] = useState<Section>("attempts");
  const [page, setPage] = useState<RunDiagnosticsOutput | null>(null);
  const [before, setBefore] = useState<{ at: string; id: string }>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setPage(null);
    void rpc.runs.diagnostics({ runId, section, limit: 25, before }).then(
      result => { if (!cancelled) setPage(result); },
      () => { if (!cancelled) setError(true); },
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [runId, section, before]);
  return <section aria-label="Run diagnostics" className="rounded-lg border p-3 text-sm">
    <label>Evidence category <select value={section} onChange={event => { setSection(event.target.value as Section); setBefore(undefined); }}>
      <option value="attempts">Attempts and lease fences</option>
      <option value="events">Execution and recovery events</option>
      <option value="effects">External effects</option>
      <option value="usage">Model calls and usage</option>
    </select></label>
    {loading ? <p role="status">Loading diagnostics…</p> : null}
    {error ? <p role="alert">Diagnostics could not be loaded.</p> : null}
    {page ? <>
      <p>Run status: {page.status}</p>
      <p className="text-muted-foreground">Evidence since {new Date(page.windowStartedAt).toLocaleString()}. History may be incomplete. Missing evidence does not establish success.</p>
      {page.entries.length === 0 ? <p>No recorded evidence in this window.</p> : <ul>{page.entries.map(entry => <li key={entry.id} className="my-2 break-words">
        <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time> — {entry.kind}{entry.status ? `: ${entry.status}` : ""}
        {entry.fence !== null ? <span> · Lease fence {entry.fence}</span> : null}
        {entry.provider ? <span> · {entry.provider} / {entry.model}</span> : null}
        {entry.callId ? <span> · Call {entry.callId}</span> : null}
        {entry.inputTokens !== null ? <span> · Input tokens {entry.inputTokens}</span> : null}
        {entry.outputTokens !== null ? <span> · Output tokens {entry.outputTokens}</span> : null}
        {entry.kind === "usage" ? <span> · Cost {entry.costMicroUsd === null ? "unknown" : `${entry.costMicroUsd} micro-USD`}</span> : null}
        <details><summary>Evidence reference</summary><p>Run {entry.evidence.runId} · Thread {entry.evidence.threadId} · Record {entry.id}{entry.evidence.eventSeq !== null ? ` · Event sequence ${entry.evidence.eventSeq}` : ""}</p></details>
      </li>)}</ul>}
      {page.nextCursor ? <button type="button" onClick={() => setBefore(page.nextCursor!)}>Older evidence</button> : null}
    </> : null}
  </section>;
}
