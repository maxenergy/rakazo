import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapacitySample } from "./storage-capacity.js";
import { TMP_MIN_BYTES } from "./storage-capacity.js";
import { CapacityCache } from "./storage-capacity-cache.js";
import type { StorageEventSink } from "./storage-guard.js";
import { StorageGuard } from "./storage-guard.js";

afterEach(() => vi.useRealTimers());
function setup() {
  const controller = new AbortController();
  let mode: "ok" | "low" | "error" = "ok";
  const probe = {
    sample: vi.fn(
      async (paths: readonly string[]): Promise<CapacitySample[]> =>
        paths.map((path) =>
          mode === "error"
            ? { path, error: "unsupported" }
            : {
                path,
                fsId: "mount",
                bavail: (mode === "low" ? 0n : TMP_MIN_BYTES).toString(),
                frsize: "1",
                availBytes: (mode === "low" ? 0n : TMP_MIN_BYTES).toString(),
                sampledAt: Date.now(),
              },
        ),
    ),
  };
  const events = { publish: vi.fn<StorageEventSink["publish"]>(async () => {}) };
  const pause = { pause: vi.fn(async () => {}) };
  const guard = new StorageGuard({
    host: "host",
    home: "home",
    tmp: "tmp",
    probe,
    cache: new CapacityCache(),
    events,
    pause,
    signal: controller.signal,
  });
  return {
    guard,
    controller,
    probe,
    events,
    pause,
    setMode: (value: typeof mode) => {
      mode = value;
    },
  };
}
describe("storage guard contract", () => {
  it("refuses unknown admission and publishes once", async () => {
    const s = setup();
    s.setMode("error");
    expect(await s.guard.admit()).toBe(false);
    expect(await s.guard.admit()).toBe(false);
    expect(s.events.publish).toHaveBeenCalledTimes(1);
    expect(s.events.publish.mock.calls[0]?.[0]).toBe("run.storage_refused");
  });
  it("pauses only at the next tool boundary and never starts another tool", async () => {
    vi.useFakeTimers();
    const s = setup();
    expect(await s.guard.admit()).toBe(true);
    s.guard.start();
    s.setMode("low");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(s.pause.pause).not.toHaveBeenCalled();
    expect(await s.guard.beforeTool()).toBe(false);
    expect(await s.guard.beforeTool()).toBe(false);
    expect(s.pause.pause).toHaveBeenCalledTimes(1);
    const count = s.probe.sample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.probe.sample).toHaveBeenCalledTimes(count);
  });
  it("warns once for repeated sampling failures without pausing", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.guard.start();
    s.setMode("error");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.events.publish).toHaveBeenCalledTimes(1);
    expect(s.events.publish.mock.calls[0]?.[0]).toBe("storage.capacity_warning");
    expect(await s.guard.beforeTool()).toBe(true);
    expect(s.pause.pause).not.toHaveBeenCalled();
    s.guard.stop();
  });
  it("stops sampling and tool admission when the lease signal aborts", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.guard.start();
    s.controller.abort();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.probe.sample).not.toHaveBeenCalled();
    expect(await s.guard.beforeTool()).toBe(false);
  });
});
