import type { Pool, PoolClient } from "pg";

export interface TrackedPool {
  /** Errors emitted on idle clients, e.g. 57P01 when Postgres is stopped on purpose. */
  readonly errors: Error[];
}

const tracked = new WeakMap<Pool, { closed: Promise<void>[] }>();

/**
 * Attach an `error` listener (an unhandled pool `error` event crashes the process) and
 * remember every client's socket close, so `endPool` can wait for real disconnection.
 */
export function trackPool<P extends Pool>(pool: P): P & TrackedPool {
  const state = { closed: [] as Promise<void>[] };
  const errors: Error[] = [];
  tracked.set(pool, state);
  pool.on("error", (error) => void errors.push(error));
  pool.on("connect", (client: PoolClient) => {
    state.closed.push(new Promise<void>((resolve) => client.once("end", () => resolve())));
  });
  return Object.assign(pool, { errors });
}

/** `pool.end()` can resolve before sockets close; wait for them before stopping Postgres. */
export async function endPool(pool: Pool): Promise<void> {
  const state = tracked.get(pool);
  await pool.end();
  if (state) await Promise.all(state.closed);
}
