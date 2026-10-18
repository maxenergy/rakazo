import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DisposableCluster } from "./disposable-postgres.js";
import { postgresAvailable, startDisposableCluster } from "./disposable-postgres.js";
import { startRestartableRuntime } from "./runtime-restart.js";

// Needs RAK_PG_BIN_DIR (and RAK_PG_LIB_DIR for unpacked builds); skipped otherwise,
// unless RAK_REQUIRE_PG=1 (set in CI), where missing binaries fail instead of skipping.
const describeCluster = postgresAvailable() ? describe.sequential : describe.skip;

if (process.env.RAK_REQUIRE_PG === "1" && !postgresAvailable()) {
  describe("acceptance harness (PostgreSQL required)", () => {
    it("has PostgreSQL 16 binaries", () => {
      throw new Error("RAK_REQUIRE_PG=1 but RAK_PG_BIN_DIR is not set; acceptance tests must not skip");
    });
  });
}

describeCluster("acceptance harness (disposable PostgreSQL)", () => {
  let cluster: DisposableCluster;
  beforeAll(async () => {
    cluster = await startDisposableCluster();
  }, 60_000);
  afterAll(async () => {
    await cluster?.stop();
  });

  it("refuses to touch databases outside the disposable prefix", async () => {
    await expect(cluster.dropDatabase("postgres")).rejects.toThrow(/non-disposable/);
  });

  it("keeps committed data across a server restart", async () => {
    const database = await cluster.createDatabase("restart");
    const pool = new Pool({ connectionString: cluster.url(database), max: 1 });
    await pool.query("CREATE TABLE t (id int primary key)");
    await pool.query("INSERT INTO t VALUES (1)");
    await pool.end();
    await cluster.restartServer();
    const again = new Pool({ connectionString: cluster.url(database), max: 1 });
    try {
      expect((await again.query("SELECT id FROM t")).rows).toEqual([{ id: 1 }]);
    } finally {
      await again.end();
      await cluster.dropDatabase(database);
    }
  });

  it("restarts a runtime explicitly and counts generations", async () => {
    const events: string[] = [];
    const runtime = await startRestartableRuntime({
      start: async () => ({ id: events.length }),
      stop: async () => void events.push("stop"),
      abandon: async () => void events.push("abandon"),
    });
    await runtime.restart("crash", async () => void events.push("down"));
    await runtime.restart("graceful");
    expect(runtime.generation).toBe(3);
    expect(events).toEqual(["abandon", "down", "stop"]);
    await runtime.shutdown();
  });
});
