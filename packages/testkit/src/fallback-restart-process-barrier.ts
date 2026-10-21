import { writeFile } from "node:fs/promises";

/** Invoke only after awaiting the executor's real onUsage persistence callback. */
export async function holdAfterUsageCommit(callId: string): Promise<never> {
  const marker = process.env.RAK19_BARRIER_PATH;
  if (!marker) throw new Error("RAK19_BARRIER_PATH is required");
  await writeFile(
    marker,
    JSON.stringify({ type: "RAK19_USAGE_COMMITTED", pid: process.pid, callId }),
    { mode: 0o600, flag: "wx" },
  );
  return await new Promise<never>(() => {
    setInterval(() => undefined, 1000);
  });
}
