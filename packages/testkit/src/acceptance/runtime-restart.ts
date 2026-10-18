/**
 * Explicit runtime-restart scaffolding for recovery tests.
 *
 * A test supplies how to start and stop its runtime (API app handles, worker host, ...).
 * Restarts are always spelled out in the test: "graceful" drains via `stop`, "crash"
 * abandons the old instance via `abandon` without letting it finish in-flight work, so
 * durable state (not memory) has to carry the recovery.
 */
export interface RestartableRuntimeConfig<Handles> {
  start(): Promise<Handles>;
  /** Graceful shutdown: drain in-flight work. */
  stop(handles: Handles): Promise<void>;
  /** Simulated crash: drop the instance without draining. Defaults to `stop`. */
  abandon?(handles: Handles): Promise<void>;
}

export type RestartMode = "graceful" | "crash";

export interface RestartableRuntime<Handles> {
  current(): Handles;
  /** Number of completed starts, so tests can assert a restart really happened. */
  readonly generation: number;
  restart(mode: RestartMode, between?: () => Promise<void>): Promise<Handles>;
  shutdown(): Promise<void>;
}

export async function startRestartableRuntime<Handles>(
  config: RestartableRuntimeConfig<Handles>,
): Promise<RestartableRuntime<Handles>> {
  let handles = await config.start();
  let generation = 1;
  let running = true;
  return {
    current() {
      if (!running) throw new Error("Runtime is shut down");
      return handles;
    },
    get generation() {
      return generation;
    },
    async restart(mode, between) {
      if (!running) throw new Error("Runtime is shut down");
      const previous = handles;
      if (mode === "crash") await (config.abandon ?? config.stop)(previous);
      else await config.stop(previous);
      // Hook for the "while down" window, e.g. completing a prerequisite or restarting Postgres.
      await between?.();
      handles = await config.start();
      generation += 1;
      return handles;
    },
    async shutdown() {
      if (!running) return;
      running = false;
      await config.stop(handles);
    },
  };
}
