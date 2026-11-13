import { Trans } from "@lingui/react/macro";
import type { Artifact } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { ArtifactFileCard } from "./ArtifactFileCard";

type ArtifactSummary = Artifact & { versionCount: number };
type Props = { projectId?: string; ticketId?: string };

export function LinkedArtifacts({ projectId, ticketId }: Props) {
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setItems([]);
    setCursor(null);
    void rpc.artifacts
      .listSpace({
        ...(projectId ? { projectId } : {}),
        ...(ticketId ? { ticketId } : {}),
        limit: 60,
      })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, ticketId]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await rpc.artifacts.listSpace({
        ...(projectId ? { projectId } : {}),
        ...(ticketId ? { ticketId } : {}),
        cursor,
        limit: 60,
      });
      setItems((current) => current.concat(page.items));
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="font-medium">
        <Trans>Artifacts</Trans>
      </h2>
      {loading ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {!loading && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No artifacts</Trans>
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <ArtifactFileCard
            key={item.id}
            target={item.botId ? { botId: item.botId } : { groupId: item.groupId! }}
            artifactId={item.id}
            name={item.name}
            mimeType={item.mimeType}
            size={item.size}
          />
        ))}
      </div>
      {cursor ? (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          className="text-sm underline"
        >
          {loadingMore ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
        </button>
      ) : null}
    </section>
  );
}
