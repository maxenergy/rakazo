import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessCapacity,
  type CapacitySample,
  HOME_MIN_BYTES,
  LocalCapacityProbe,
  parseCapacitySamples,
  TMP_MIN_BYTES,
} from "./storage-capacity.js";
import { CapacityCache } from "./storage-capacity-cache.js";

function sample(path: string, bytes: bigint, fsId = "mount"): CapacitySample {
  return {
    path,
    fsId,
    bavail: bytes.toString(),
    frsize: "1",
    availBytes: bytes.toString(),
    sampledAt: 1,
  };
}
afterEach(() => vi.useRealTimers());
describe("storage capacity admission", () => {
  it.each([
    [HOME_MIN_BYTES - 1n, TMP_MIN_BYTES, false],
    [HOME_MIN_BYTES, TMP_MIN_BYTES - 1n, false],
    [HOME_MIN_BYTES, TMP_MIN_BYTES, true],
    [HOME_MIN_BYTES - 1n, TMP_MIN_BYTES - 1n, false],
  ])("checks strict byte boundaries (%s, %s)", (home, tmp, allowed) => {
    expect(assessCapacity([sample("home", home), sample("tmp", tmp)], "home", "tmp").allowed).toBe(
      allowed,
    );
  });
  it("never sums capacity on the same mount", () => {
    expect(
      assessCapacity([sample("home", HOME_MIN_BYTES), sample("tmp", HOME_MIN_BYTES)], "home", "tmp")
        .reason,
    ).toBe("storage_low");
  });
  it("fails closed for missing and failed samples", () => {
    expect(assessCapacity([], "home", "tmp").reason).toBe("capacity_unknown");
    expect(
      assessCapacity(
        [{ path: "home", error: "permission" }, sample("tmp", TMP_MIN_BYTES)],
        "home",
        "tmp",
      ).reason,
    ).toBe("capacity_unknown");
  });
  it("preserves statvfs integer precision and rejects inconsistent products", () => {
    const row = {
      path: "/tmp",
      fsId: "1",
      bavail: "9007199254740993",
      frsize: "4096",
      availBytes: (9007199254740993n * 4096n).toString(),
      sampledAt: 1,
    };
    expect(parseCapacitySamples(JSON.stringify([row]), ["/tmp"])[0]).toEqual(row);
    expect(() =>
      parseCapacitySamples(JSON.stringify([{ ...row, availBytes: "1" }]), ["/tmp"]),
    ).toThrow();
  });
  it("samples real /tmp using statvfs without filling disk", async () => {
    const rows = await new LocalCapacityProbe().sample(["/tmp"], new AbortController().signal);
    const row = rows[0]!;
    expect("error" in row).toBe(false);
    if ("error" in row) throw new Error(row.error);
    expect(BigInt(row.availBytes)).toBe(BigInt(row.bavail) * BigInt(row.frsize));
  });
  it("shares concurrent probes and expires host/path cache at 60 seconds", async () => {
    vi.useFakeTimers();
    const probe = {
      sample: vi.fn(async (paths: readonly string[]) =>
        paths.map((path) => sample(path, TMP_MIN_BYTES)),
      ),
    };
    const cache = new CapacityCache();
    await Promise.all([cache.sample("a", ["/tmp"], probe), cache.sample("a", ["/tmp"], probe)]);
    expect(probe.sample).toHaveBeenCalledTimes(1);
    await cache.sample("b", ["/tmp"], probe);
    expect(probe.sample).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await cache.sample("a", ["/tmp"], probe);
    expect(probe.sample).toHaveBeenCalledTimes(3);
  });
  it("bounds unresponsive probes to five seconds and aborts the channel", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const probe = {
      sample: (_paths: readonly string[], incoming: AbortSignal) => {
        signal = incoming;
        return new Promise<CapacitySample[]>(() => {});
      },
    };
    const pending = new CapacityCache().sample("host", ["/tmp"], probe);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual([{ path: "/tmp", error: "capacity_timeout" }]);
    expect(signal?.aborted).toBe(true);
  });
});
