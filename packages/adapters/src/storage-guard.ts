import type { CapacityDecision, CapacityProbe } from "./storage-capacity.js";
import { assessCapacity, CAPACITY_INTERVAL_MS } from "./storage-capacity.js";
import type { CapacityCache } from "./storage-capacity-cache.js";

export interface StoragePauseSink {
  pause(decision: CapacityDecision): Promise<void>;
}
export interface StorageEventSink {
  publish(
    type: "run.storage_refused" | "storage.capacity_warning",
    decision: CapacityDecision,
  ): Promise<void>;
}

/** One guard per claimed run segment; event persistence and fencing belong to the sink. */
export class StorageGuard {
  private stopped = false;
  private busy = false;
  private low: CapacityDecision | undefined;
  private paused = false;
  private warning = false;
  private refused = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly options: {
      host: string;
      home: string;
      tmp: string;
      probe: CapacityProbe;
      cache: CapacityCache;
      events: StorageEventSink;
      pause?: StoragePauseSink;
      signal: AbortSignal;
    },
  ) {}
  private async sample() {
    const o = this.options;
    return assessCapacity(await o.cache.sample(o.host, [o.home, o.tmp], o.probe), o.home, o.tmp);
  }
  async admit(): Promise<boolean> {
    if (this.stopped || this.options.signal.aborted) return false;
    const decision = await this.sample();
    if (this.stopped || this.options.signal.aborted) return false;
    // A probe that could not answer in time says nothing about the disk; refusing on it
    // turned a busy computer into failed runs. Warn and admit; refuse only real low space.
    if (decision.reason === "capacity_unknown") {
      if (!this.warning) {
        await this.options.events.publish("storage.capacity_warning", decision);
        this.warning = true;
      }
      return true;
    }
    if (!decision.allowed && !this.refused) {
      await this.options.events.publish("run.storage_refused", decision);
      this.refused = true;
    }
    return decision.allowed;
  }
  start(): void {
    if (this.timer || this.stopped || this.options.signal.aborted) return;
    this.options.signal.addEventListener("abort", this.stop, { once: true });
    this.timer = setInterval(() => {
      void this.check().catch(() => undefined);
    }, CAPACITY_INTERVAL_MS);
    this.timer.unref?.();
  }
  async check(): Promise<void> {
    if (this.busy || this.stopped || this.options.signal.aborted) return;
    this.busy = true;
    try {
      const decision = await this.sample();
      if (this.stopped || this.options.signal.aborted) return;
      if (decision.reason === "capacity_unknown") {
        if (!this.warning) {
          await this.options.events.publish("storage.capacity_warning", decision);
          this.warning = true;
        }
      } else {
        this.warning = false;
        if (decision.reason === "storage_low") this.low = decision;
      }
    } finally {
      this.busy = false;
    }
  }
  /** Called before starting a tool or heavy segment, never to interrupt an in-flight tool. */
  async beforeTool(): Promise<boolean> {
    if (this.stopped || this.options.signal.aborted || this.paused) return false;
    if (!this.low || !this.options.pause) return true;
    this.paused = true;
    this.stop();
    await this.options.pause.pause(this.low);
    return false;
  }
  readonly stop = (): void => {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.options.signal.removeEventListener("abort", this.stop);
  };
}
