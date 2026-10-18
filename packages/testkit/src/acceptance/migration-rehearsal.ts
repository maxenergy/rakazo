import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT, startDisposableCluster } from "./disposable-postgres.js";

const execFileAsync = promisify(execFile);

export interface RehearsalResult {
  ok: boolean;
  migrationCount: number;
  /** Output of `prisma migrate diff` (migrations vs schema.prisma); empty means no drift. */
  drift: string;
  /** Tickets whose known drift was matched exactly and tolerated; remove an entry when its ticket lands. */
  knownDrift: string[];
}

/** Prisma CLI banner printed before the script, e.g. `◇ injected env (0) from .env // tip: ...`. */
const PRISMA_BANNER = /^◇ injected env \(\d+\) from \.env(?: \/\/ tip: .*)?$/;

/** Drift that is already ticketed. Matched as an exact statement block, never by pattern. */
const KNOWN_DRIFT: { ticket: string; script: string }[] = [
  {
    ticket: "RAK-6",
    script: [
      "-- DropForeignKey",
      'ALTER TABLE "computer_updates" DROP CONSTRAINT "computer_updates_computerId_fkey";',
      "",
      "-- AddForeignKey",
      'ALTER TABLE "computer_updates" ADD CONSTRAINT "computer_updates_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    ].join("\n"),
  },
];

function stripBanner(output: string): string {
  return output
    .split("\n")
    .filter((line) => !PRISMA_BANNER.test(line.trim()))
    .join("\n")
    .trim();
}

/**
 * Builds a throwaway database from the migration history on a private cluster and checks
 * that it matches schema.prisma. Only databases on the disposable cluster are ever used.
 */
export async function rehearseMigrations(): Promise<RehearsalResult> {
  const dbDir = path.join(REPO_ROOT, "packages/db");
  const migrationCount = (
    await readdir(path.join(dbDir, "prisma/migrations"), { withFileTypes: true })
  ).filter((entry) => entry.isDirectory()).length;

  const cluster = await startDisposableCluster();
  try {
    const database = await cluster.createDatabase("rehearsal");
    await cluster.migrate(database);
    const diff = await execFileAsync(
      "pnpm",
      [
        "exec",
        "prisma",
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--script",
      ],
      { cwd: dbDir, env: { ...process.env, DATABASE_URL: cluster.url(database) } },
    );
    let drift = stripBanner(diff.stdout);
    if (drift === "-- This is an empty migration.") drift = "";
    const knownDrift: string[] = [];
    for (const known of KNOWN_DRIFT) {
      if (drift.includes(known.script)) {
        drift = drift.replace(known.script, "").trim();
        knownDrift.push(known.ticket);
      }
    }
    await cluster.dropDatabase(database);
    return { ok: drift === "", migrationCount, drift, knownDrift };
  } finally {
    await cluster.stop();
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  rehearseMigrations().then(
    (result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    },
  );
}
