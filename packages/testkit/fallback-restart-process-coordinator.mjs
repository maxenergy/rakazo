import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.RAK19_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) {
  throw new Error(
    "Requires DATABASE_URL for a disposable database and RAK19_DISPOSABLE_DATABASE=1",
  );
}
const dir = await mkdtemp(join(tmpdir(), "rak19-process-"));
console.log(`Evidence state directory: ${dir}`);
const state = join(dir, "state.json");
const toolMarker = join(dir, "tool-runs.jsonl");
const marker = join(dir, "usage-committed.json");
function launch(phase) {
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "packages/testkit/vitest.fallback-restart-process.config.ts",
    ],
    {
      env: {
        ...process.env,
        VERIFY_DATABASE: "1",
        RAK19_WORKER_PHASE: phase,
        RAK19_STATE_PATH: state,
        RAK19_BARRIER_PATH: marker,
        RAK19_TOOL_MARKER_PATH: toolMarker,
      },
      stdio: "inherit",
    },
  );
  const done = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, done };
}
const crash = launch("crash");
let exited;
crash.done.then((result) => {
  exited = result;
});
let barrier;
const deadline = Date.now() + 90000;
try {
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Crash phase exited before barrier: ${JSON.stringify(exited)}`);
    try {
      barrier = JSON.parse(await readFile(marker, "utf8"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  if (
    !barrier ||
    barrier.type !== "RAK19_USAGE_COMMITTED" ||
    typeof barrier.callId !== "string" ||
    !barrier.callId ||
    !Number.isInteger(barrier.pid) ||
    barrier.pid <= 1
  ) {
    throw new Error("No valid durable usage barrier before timeout");
  }
  const status = await readFile(`/proc/${barrier.pid}/status`, "utf8");
  const parent = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
  if (parent !== crash.child.pid)
    throw new Error("Barrier worker is not a child of the owned Vitest runner");
  process.kill(barrier.pid, "SIGKILL");
  console.log("SIGKILL sent to fixture worker after durable usage commit");
  const result = await Promise.race([crash.done, delay(15000).then(() => ({ timeout: true }))]);
  if (result.timeout) throw new Error("Crash runner did not exit after worker SIGKILL");
  // Vitest runner reports failure when its fork is killed; the worker received SIGKILL above.
  if (!result.error && result.code === 0) throw new Error("Crash runner unexpectedly succeeded");
  console.log(`Crash runner outcome: ${JSON.stringify(result)}`);
} finally {
  if (crash.child.exitCode === null && crash.child.signalCode === null) crash.child.kill("SIGKILL");
}
const recovery = launch("recover");
const result = await recovery.done;
if (result.error || result.code !== 0)
  throw new Error(`Recovery failed: ${JSON.stringify(result)}`);
console.log("Independent crash/recovery fixture passed; this is not final integration acceptance");
