import { Trans, useLingui } from "@lingui/react/macro";
import type { TicketDependencies as DependencyState } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";

export function TicketDependencies({ ticketId, revision, onSaved }: { ticketId: string; revision?: unknown; onSaved: () => Promise<void> }) {
  const { t } = useLingui();
  const inputId = useId();
  const [state, setState] = useState<DependencyState | null>(null);
  const [prerequisiteId, setPrerequisiteId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setState(null);
    void rpc.tickets.dependencies({ ticketId }).then((value) => {
      if (active) { setState(value); setError(""); }
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [ticketId, revision]);
  async function edit(action: "add" | "remove", id: string) {
    setBusy(true);
    setError("");
    try {
      const input = { ticketId, prerequisiteId: id };
      const value = action === "add" ? await rpc.tickets.addDependency(input) : await rpc.tickets.removeDependency(input);
      setState(value);
      if (action === "add") setPrerequisiteId("");
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }
  return <section className="min-w-0 space-y-3" aria-label={t`Dependencies`}>
    <h3 className="text-sm font-medium"><Trans>Dependencies</Trans></h3>
    {error ? <p role="alert" className="break-words text-sm text-destructive">{error}</p> : null}
    {state ? <>
      <p role="status" className="text-sm">{state.blockedByDependency ? <Trans>Blocked by dependency</Trans> : <Trans>No incomplete prerequisites</Trans>}</p>
      <h4 className="text-sm font-medium"><Trans>Prerequisites</Trans></h4>
      <ul className="space-y-2">{state.prerequisites.map((item) => <li key={item.id} className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words text-sm">{item.ref}: {item.title} ({item.status})</span><Button type="button" variant="outline" disabled={busy} aria-label={t`Remove prerequisite ${item.ref}`} onClick={() => void edit("remove", item.id)}><Trans>Remove</Trans></Button></li>)}</ul>
      <h4 className="text-sm font-medium"><Trans>Dependents</Trans></h4>
      <ul>{state.dependents.map((item) => <li key={item.id} className="break-words text-sm">{item.ref}: {item.title} ({item.status})</li>)}</ul>
    </> : null}
    <label htmlFor={inputId} className="block text-sm"><Trans>Prerequisite ticket ID</Trans></label>
    <div className="flex min-w-0 flex-wrap gap-2"><Input id={inputId} className="min-w-0 flex-1" value={prerequisiteId} onChange={(event) => setPrerequisiteId(event.target.value)} /><Button type="button" disabled={busy || !prerequisiteId.trim()} onClick={() => void edit("add", prerequisiteId.trim())}><Trans>Add prerequisite</Trans></Button></div>
  </section>;
}
