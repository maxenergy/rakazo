import { createAbandonedJobCleanup, GraphileJobPublisher } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisposableCluster } from "./disposable-postgres.js";
import { postgresAvailable, startDisposableCluster } from "./disposable-postgres.js";

const describeCluster = postgresAvailable() ? describe.sequential : describe.skip;

if (process.env.RAK_REQUIRE_PG === "1" && !postgresAvailable()) {
  it("requires PostgreSQL binaries for abandoned job cleanup", () => {
    throw new Error("RAK_PG_BIN_DIR is required");
  });
}

describeCluster("abandoned Graphile jobs (real PostgreSQL schema)", () => {
  let cluster: DisposableCluster;
  let pool: Pool;
  let publisher: GraphileJobPublisher;

  beforeAll(async () => {
    cluster = await startDisposableCluster();
    const database = await cluster.createDatabase("abandoned_jobs");
    pool = new Pool({ connectionString: cluster.url(database), max: 1 });
    publisher = new GraphileJobPublisher(pool);
    // The publisher initializes the actual version-pinned Graphile schema.
    await publisher.cancel("cleanup.schema.bootstrap");
  }, 60_000);

  afterAll(async () => {
    await publisher?.close();
    await pool?.end();
    await cluster?.stop();
  });

  beforeEach(async () => {
    await pool.query("BEGIN");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.query("ROLLBACK");
  });

  async function abandoned() {
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM graphile_worker.add_job('cleanup.contract', '{}'::json)",
    );
    const id = result.rows[0]!.id;
    await pool.query(
      `
      UPDATE graphile_worker._private_jobs
      SET attempts = max_attempts, updated_at = now() - interval '8 days',
          run_at = now() - interval '8 days'
      WHERE id = $1
    `,
      [id],
    );
    return id;
  }

  async function exists(id: string) {
    return (
      (await pool.query("SELECT id FROM graphile_worker._private_jobs WHERE id = $1", [id]))
        .rowCount === 1
    );
  }

  it.each([
    ["key", "key = 'protected-key'"],
    ["attempts", "attempts = max_attempts - 1"],
    ["last_error", "last_error = 'retained diagnostic'"],
    ["locked_at", "locked_at = now(), locked_by = 'cleanup-contract'"],
  ])("preserves a row when %s disqualifies it", async (_field, update) => {
    const id = await abandoned();
    await pool.query(`UPDATE graphile_worker._private_jobs SET ${update} WHERE id = $1`, [id]);
    await createAbandonedJobCleanup(pool)();
    expect(await exists(id)).toBe(true);
  });

  it.each(["updated_at", "run_at"])(
    "honors both sides and the exact %s boundary",
    async (field) => {
      const old = await abandoned();
      const boundary = await abandoned();
      const recent = await abandoned();
      await pool.query(
        `UPDATE graphile_worker._private_jobs SET ${field} = now() - interval '7 days' - interval '1 second' WHERE id = $1`,
        [old],
      );
      await pool.query(
        `UPDATE graphile_worker._private_jobs SET ${field} = now() - interval '7 days' WHERE id = $1`,
        [boundary],
      );
      await pool.query(
        `UPDATE graphile_worker._private_jobs SET ${field} = now() - interval '7 days' + interval '1 second' WHERE id = $1`,
        [recent],
      );
      await createAbandonedJobCleanup(pool)();
      expect(await exists(old)).toBe(false);
      expect(await exists(boundary)).toBe(true);
      expect(await exists(recent)).toBe(true);
    },
  );

  it("retains a locked job abandoned by real remove_job until unlocked and aged", async () => {
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM graphile_worker.add_job('cleanup.contract', '{}'::json, job_key := 'locked-contract')",
    );
    const id = result.rows[0]!.id;
    await pool.query(
      `
      UPDATE graphile_worker._private_jobs
      SET locked_at = now(), locked_by = 'cleanup-contract',
          updated_at = now() - interval '8 days', run_at = now() - interval '8 days'
      WHERE id = $1
    `,
      [id],
    );
    await pool.query("SELECT graphile_worker.remove_job('locked-contract')");
    const abandonedRow = await pool.query(
      "SELECT key, attempts = max_attempts AS exhausted, updated_at = now() AS refreshed FROM graphile_worker._private_jobs WHERE id = $1",
      [id],
    );
    expect(abandonedRow.rows).toEqual([{ key: null, exhausted: true, refreshed: true }]);
    await createAbandonedJobCleanup(pool)();
    expect(await exists(id)).toBe(true);
    await pool.query(
      "UPDATE graphile_worker._private_jobs SET locked_at = NULL, locked_by = NULL WHERE id = $1",
      [id],
    );
    await createAbandonedJobCleanup(pool)();
    expect(await exists(id)).toBe(true);
    await pool.query(
      "UPDATE graphile_worker._private_jobs SET updated_at = now() - interval '8 days' WHERE id = $1",
      [id],
    );
    await createAbandonedJobCleanup(pool)();
    expect(await exists(id)).toBe(false);
  });

  it("runs immediately, logs zero, and throttles attempts for an hour", async () => {
    const info = vi.spyOn(getLogger(), "info");
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const cleanup = createAbandonedJobCleanup(pool);
    await cleanup();
    expect(info).toHaveBeenLastCalledWith("abandoned Graphile jobs cleanup", {
      deletedRows: 0,
      retentionDays: 7,
      durationMs: 0,
    });
    const id = await abandoned();
    clock.mockReturnValue(3_599_999);
    await cleanup();
    expect(await exists(id)).toBe(true);
    clock.mockReturnValue(3_600_000);
    await cleanup();
    expect(await exists(id)).toBe(false);
    expect(info).toHaveBeenLastCalledWith("abandoned Graphile jobs cleanup", {
      deletedRows: 1,
      retentionDays: 7,
      durationMs: 0,
    });
  });

  it("logs failure without throwing and throttles failed attempts", async () => {
    const error = vi.spyOn(getLogger(), "error");
    // Inject failure without discarding the connection that owns the test transaction.
    const query = vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("cleanup query failed"));
    const cleanup = createAbandonedJobCleanup(pool);
    await expect(cleanup()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("abandoned Graphile jobs cleanup", expect.any(Error));
    query.mockRestore();
    const id = await abandoned();
    await cleanup();
    expect(await exists(id)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
