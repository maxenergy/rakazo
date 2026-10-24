import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const HOME_MIN_BYTES = 20n * 1024n ** 3n;
export const TMP_MIN_BYTES = 50n * 1024n ** 3n;
export const CAPACITY_TIMEOUT_MS = 30_000;
export const CAPACITY_CACHE_MS = 60_000;
export const CAPACITY_INTERVAL_MS = 300_000;

export type CapacitySample =
  | {
      path: string;
      fsId: string;
      bavail: string;
      frsize: string;
      availBytes: string;
      sampledAt: number;
    }
  | { path: string; error: string };
export interface CapacityProbe {
  sample(paths: readonly string[], signal: AbortSignal): Promise<CapacitySample[]>;
}
export type CapacityDecision = {
  allowed: boolean;
  reason: "sufficient" | "storage_low" | "capacity_unknown";
  samples: CapacitySample[];
};

// Run on the execution host through its existing command channel. Decimal strings
// preserve statvfs precision across JSON, including values above Number.MAX_SAFE_INTEGER.
export const STATVFS_SCRIPT = [
  "import json,os,sys,time",
  "rows=[]",
  "for p in sys.argv[1:]:",
  " try:",
  "  s=os.statvfs(p)",
  "  rows.append(dict(path=p,fsId=str(os.stat(p).st_dev),bavail=str(s.f_bavail),frsize=str(s.f_frsize),availBytes=str(s.f_bavail*s.f_frsize),sampledAt=int(time.time()*1000)))",
  " except Exception as e: rows.append(dict(path=p,error=type(e).__name__))",
  "print(json.dumps(rows))",
].join("\n");

export function parseCapacitySamples(output: string, paths: readonly string[]): CapacitySample[] {
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows) || rows.length !== paths.length)
    throw new Error("Invalid capacity response");
  return paths.map((path, index) => {
    const row = rows[index];
    if (!row || row.path !== path) throw new Error("Capacity path mismatch");
    if (typeof row.error === "string") return { path, error: row.error };
    for (const key of ["bavail", "frsize", "availBytes"]) {
      if (typeof row[key] !== "string" || !/^\d+$/.test(row[key]))
        throw new Error("Invalid capacity bytes");
    }
    if (
      BigInt(row.frsize) <= 0n ||
      BigInt(row.bavail) * BigInt(row.frsize) !== BigInt(row.availBytes) ||
      typeof row.fsId !== "string" ||
      !Number.isFinite(row.sampledAt)
    ) {
      throw new Error("Invalid statvfs response");
    }
    return {
      path,
      fsId: row.fsId,
      bavail: row.bavail,
      frsize: row.frsize,
      availBytes: row.availBytes,
      sampledAt: row.sampledAt,
    };
  });
}

export class LocalCapacityProbe implements CapacityProbe {
  async sample(paths: readonly string[], signal: AbortSignal): Promise<CapacitySample[]> {
    const { stdout } = await promisify(execFile)("python3", ["-c", STATVFS_SCRIPT, ...paths], {
      signal,
      timeout: CAPACITY_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    return parseCapacitySamples(stdout, paths);
  }
}

export function assessCapacity(
  samples: CapacitySample[],
  home: string,
  tmp: string,
): CapacityDecision {
  const homeSample = samples.find((sample) => sample.path === home);
  const tmpSample = samples.find((sample) => sample.path === tmp);
  if (!homeSample || !tmpSample || "error" in homeSample || "error" in tmpSample) {
    return { allowed: false, reason: "capacity_unknown", samples };
  }
  // Check both paths independently, even when their fsId matches. Never sum free space.
  const low =
    BigInt(homeSample.availBytes) < HOME_MIN_BYTES || BigInt(tmpSample.availBytes) < TMP_MIN_BYTES;
  return { allowed: !low, reason: low ? "storage_low" : "sufficient", samples };
}
