import { useEffect, useRef, useState } from "react";
import { rpc, selectedSpaceId } from "./rpc";

/** Re-read authoritative state after board signals, including heartbeat and reconnect. */
export function useBoardRefresh<T>(load: (spaceId: string | null) => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const revision = useRef(0);

  useEffect(() => {
    const spaceId = selectedSpaceId();
    let active = true;
    let controller: AbortController | undefined;
    let cancelRetry: (() => void) | undefined;
    setData(undefined);
    setError(undefined);

    async function refresh() {
      const request = ++revision.current;
      const next = await load(spaceId);
      if (!active || request !== revision.current || selectedSpaceId() !== spaceId) return;
      setData(next);
      setError(undefined);
    }

    void (async () => {
      while (active && selectedSpaceId() === spaceId) {
        controller = new AbortController();
        try {
          const stream = await rpc.boards.subscribe(undefined, {
            signal: controller.signal,
            context: { spaceId },
          });
          if (!active) return;
          await refresh();
          for await (const event of stream) {
            if (!active || selectedSpaceId() !== spaceId) return;
            if (event.spaceId !== spaceId && spaceId !== null) continue;
            await refresh();
          }
        } catch (cause) {
          if (active && selectedSpaceId() === spaceId) setError(cause);
        } finally {
          controller.abort();
        }
        if (!active || selectedSpaceId() !== spaceId) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          cancelRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        cancelRetry = undefined;
      }
    })();

    return () => {
      active = false;
      ++revision.current;
      controller?.abort();
      cancelRetry?.();
    };
  }, [load]);

  return { data, error };
}
