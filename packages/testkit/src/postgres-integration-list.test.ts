import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// These suites own disposable PG16 clusters and run in the unit-test job.
// Explicit paths ensure new acceptance suites still require registration.
const selfContained = new Set([
  "packages/testkit/src/acceptance/execution-fence.postgres.test.ts",
  // Skips in CI; proof is the local fallback restart PG16 script run, like goal-dependency-recovery.
  "packages/testkit/src/fallback-restart.postgres.test.ts",
  "packages/testkit/src/acceptance/acceptance.postgres.test.ts",
  "packages/testkit/src/acceptance/approval-recovery.postgres.test.ts",
  "packages/testkit/src/acceptance/goal-dependency-recovery.postgres.test.ts",
  "packages/testkit/src/acceptance/ticket-wake-runtime.postgres.test.ts",
  "packages/testkit/src/acceptance/wake-recovery.postgres.test.ts",
]);

it("registers every PostgreSQL suite in the harness or explicit self-contained allowlist", () => {
  const source = readFileSync(new URL("./cli/harness.ts", import.meta.url), "utf8");
  const arrays = [...source.matchAll(/const suites\s*=\s*\[([\s\S]*?)\];/g)];
  expect(arrays, "expected one integration suites array in harness.ts").toHaveLength(1);
  const body = arrays[0]![1]!;
  const registered = new Set(
    [...body.matchAll(/"([^"]+\.postgres\.test\.ts)"/g)].map((match) => match[1]!),
  );
  expect(
    registered.size,
    "integration suites must contain literal PostgreSQL paths",
  ).toBeGreaterThan(0);

  const discovered = new Set(
    globSync("**/*.postgres.test.ts", {
      cwd: root,
      exclude: ["**/node_modules/**", "**/.git/**"],
    }).map((name) => name.replaceAll("\\", "/")),
  );
  const missing = [...discovered]
    .filter((name) => !registered.has(name) && !selfContained.has(name))
    .sort();
  expect(missing, `PostgreSQL suites missing from harness.ts:\n${missing.join("\n")}`).toEqual([]);
  const stale = [...registered, ...selfContained].filter((name) => !discovered.has(name)).sort();
  expect(stale, "registered PostgreSQL suites must exist").toEqual([]);
});
