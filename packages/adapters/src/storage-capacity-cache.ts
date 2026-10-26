import type { CapacityProbe, CapacitySample } from "./storage-capacity.js";
import { CAPACITY_CACHE_MS, CAPACITY_TIMEOUT_MS } from "./storage-capacity.js";

/** Host/path cache shared by admissions and periodic checks. */
export class CapacityCache {
  private readonly entries = new Map<string, { expiresAt: number; value: CapacitySample }>();
  private readonly pending = new Map<string, Promise<CapacitySample>>();

  constructor(private readonly now: () => number = Date.now) {}

  async sample(
    host: string,
    paths: readonly string[],
    probe: CapacityProbe,
  ): Promise<CapacitySample[]> {
    return Promise.all(paths.map((path) => this.samplePath(host, path, probe)));
  }

  private samplePath(host: string, path: string, probe: CapacityProbe): Promise<CapacitySample> {
    const key = JSON.stringify([host, path]);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = this.measure(path, probe)
      .then((value) => {
        this.entries.set(key, { expiresAt: this.now() + CAPACITY_CACHE_MS, value });
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, operation);
    return operation;
  }

  private async measure(path: string, probe: CapacityProbe): Promise<CapacitySample> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("capacity_timeout"));
        }, CAPACITY_TIMEOUT_MS);
      });
      const rows = await Promise.race([probe.sample([path], controller.signal), timeout]);
      if (rows.length !== 1 || rows[0]?.path !== path) throw new Error("capacity_invalid_response");
      return rows[0];
    } catch (error) {
      return { path, error: error instanceof Error ? error.message : "capacity_unknown" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
