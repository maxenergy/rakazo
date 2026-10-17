import { Trans } from "@lingui/react/macro";
import { ClipboardCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { rpc } from "../../lib/rpc";

const REFRESH_MS = 20_000;

/** Sidebar entry that appears only while proposals wait for the owner's decision. */
export function PendingApprovalsLink({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () =>
      rpc.proposals
        .list({ status: "pending" })
        .then((proposals) => {
          if (active) setPending(proposals.length);
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (pending === 0) return null;
  return (
    <button
      type="button"
      data-testid="pending-approvals-link"
      onClick={() => {
        onNavigate?.();
        navigate("/app/approvals");
      }}
      className="mx-3 mb-1 flex items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-sidebar-accent"
    >
      <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-accent text-foreground/80">
        <ClipboardCheck size={15} strokeWidth={1.8} />
      </span>
      <span className="flex-1 text-left text-[14px] font-medium text-foreground/90">
        <Trans>Approvals</Trans>
      </span>
      <span className="rounded-full bg-primary px-2 text-[12px] font-medium text-primary-foreground">
        {pending}
      </span>
    </button>
  );
}
