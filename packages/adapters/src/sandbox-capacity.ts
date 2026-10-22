import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { CapacityProbe, CapacitySample } from "./storage-capacity.js";
import { CAPACITY_TIMEOUT_MS, parseCapacitySamples, STATVFS_SCRIPT } from "./storage-capacity.js";

/** Samples inside the execution computer using its existing command channel. */
export class SandboxCapacityProbe implements CapacityProbe {
  constructor(
    private readonly sandbox: SandboxProvider,
    private readonly computer: ComputerRef,
    private readonly context: AdapterContext,
  ) {}
  async sample(paths: readonly string[], signal: AbortSignal): Promise<CapacitySample[]> {
    let stdout = "";
    let exitCode: number | undefined;
    for await (const event of this.sandbox.execute(
      this.computer,
      { argv: ["python3", "-c", STATVFS_SCRIPT, ...paths], timeoutMs: CAPACITY_TIMEOUT_MS },
      { ...this.context, signal },
    )) {
      signal.throwIfAborted();
      if (event.type === "stdout") {
        stdout += event.data;
        if (stdout.length > 64 * 1024) throw new Error("capacity_response_too_large");
      } else if (event.type === "exit") exitCode = event.code;
    }
    if (exitCode !== 0) throw new Error("capacity_probe_failed");
    return parseCapacitySamples(stdout, paths);
  }
}
