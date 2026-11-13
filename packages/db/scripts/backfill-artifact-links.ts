import type { PoolClient } from "pg";
import { Pool } from "pg";
import type { HistoricalArtifact, HistoricalTicket } from "../src/artifact-backfill.js";
import { planArtifactBackfill } from "../src/artifact-backfill.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const spaceId = args.find((arg) => arg.startsWith("--space-id="))?.slice(11);
if (!spaceId || args.some((arg) => arg !== "--apply" && !arg.startsWith("--space-id="))) {
  throw new Error("Usage: backfill-artifact-links.ts --space-id=<id> [--apply]");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let client: PoolClient | undefined;
try {
  client = await pool.connect();
  await client.query(
    apply
      ? "BEGIN ISOLATION LEVEL REPEATABLE READ"
      : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  const { rows: tickets } = await client.query<HistoricalTicket>(
    `
    SELECT t.id, t."spaceId", t.number, t."projectId", t."milestoneId",
      ((t."projectId" IS NULL OR p.id IS NOT NULL) AND
       (t."milestoneId" IS NULL OR (m.id IS NOT NULL AND m."projectId" = t."projectId"))) AS valid
    FROM tickets t JOIN boards b ON b.id = t."boardId" AND b."spaceId" = t."spaceId"
    LEFT JOIN projects p ON p.id = t."projectId" AND p."spaceId" = t."spaceId"
    LEFT JOIN milestones m ON m.id = t."milestoneId" AND m."spaceId" = t."spaceId"
    WHERE t."spaceId" = $1 AND b."ticketPrefix" = 'RAK'`,
    [spaceId],
  );
  const { rows: artifacts } = await client.query<HistoricalArtifact>(
    `
    SELECT id, "spaceId", name, description, project_id AS "projectId",
      milestone_id AS "milestoneId", ticket_id AS "ticketId", link_source AS "linkSource"
    FROM artifacts WHERE "spaceId" = $1 ORDER BY id ${apply ? "FOR UPDATE" : ""}`,
    [spaceId],
  );
  const stats = {
    mode: apply ? "apply" : "dry-run",
    total: artifacts.length,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    skipped: 0,
    updated: 0,
    reasons: {} as Record<string, number>,
  };
  for (const artifact of artifacts) {
    const plan = planArtifactBackfill(artifact, tickets);
    stats[plan.kind]++;
    if (plan.kind !== "matched") {
      stats.reasons[plan.reason] = (stats.reasons[plan.reason] ?? 0) + 1;
      continue;
    }
    if (apply) {
      const result = await client.query(
        `
        UPDATE artifacts SET project_id = COALESCE(project_id, $2),
          milestone_id = COALESCE(milestone_id, $3), ticket_id = COALESCE(ticket_id, $4),
          link_source = COALESCE(link_source, $5)
        WHERE id = $1 AND "spaceId" = $6`,
        [
          artifact.id,
          plan.links.projectId,
          plan.links.milestoneId,
          plan.links.ticketId,
          plan.links.linkSource,
          spaceId,
        ],
      );
      stats.updated += result.rowCount ?? 0;
    }
  }
  await client.query("COMMIT");
  process.stdout.write(`${JSON.stringify(stats)}\n`);
} catch (error) {
  if (client) await client.query("ROLLBACK");
  // Connection errors may contain credentials or private server details.
  process.stderr.write(`${error instanceof Error ? error.name : "Backfill failed"}\n`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
