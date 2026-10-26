import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { SandboxCapacityProbe } from "./sandbox-capacity.js";
import { CAPACITY_TIMEOUT_MS } from "./storage-capacity.js";

function setup(events: unknown[]) {
  const execute = vi.fn(async function* () {
    yield* events;
  });
  const sandbox = { execute } as unknown as SandboxProvider;
  const computer = { id: "fake-computer", kind: "desktop", botId: "fake-bot" } as ComputerRef;
  const controller = new AbortController();
  const context = { signal: controller.signal } as AdapterContext;
  return {
    execute,
    computer,
    controller,
    probe: new SandboxCapacityProbe(sandbox, computer, context),
  };
}

describe("sandbox capacity probe", () => {
  it("samples through the target computer and propagates the timeout signal", async () => {
    const row = {
      path: "/tmp",
      fsId: "fake-fs",
      bavail: "7",
      frsize: "4096",
      availBytes: "28672",
      sampledAt: 123,
    };
    const s = setup([
      { type: "stdout", data: JSON.stringify([row]) },
      { type: "exit", code: 0 },
    ]);
    expect(await s.probe.sample(["/tmp"], s.controller.signal)).toEqual([row]);
    expect(s.execute).toHaveBeenCalledWith(
      s.computer,
      expect.objectContaining({
        argv: expect.arrayContaining(["python3", "/tmp"]),
        timeoutMs: CAPACITY_TIMEOUT_MS,
      }),
      expect.objectContaining({ signal: s.controller.signal }),
    );
  });
  it.each([{ events: [] }, { events: [{ type: "exit", code: 1 }] }])(
    "rejects missing or unsuccessful exit: %j",
    async ({ events }) => {
      const s = setup(events);
      await expect(s.probe.sample(["/tmp"], s.controller.signal)).rejects.toThrow();
    },
  );
  it("rejects output after cancellation", async () => {
    const s = setup([{ type: "stdout", data: "[]" }]);
    s.controller.abort();
    await expect(s.probe.sample(["/tmp"], s.controller.signal)).rejects.toThrow();
  });
});
