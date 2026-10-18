import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);

/** Repo root, resolved from packages/testkit/src/acceptance. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

/** Every database this harness creates carries this prefix; nothing else can be dropped. */
export const DISPOSABLE_DB_PREFIX = "rak_t_";

const DB_NAME = /^rak_t_[a-z0-9_]{1,40}$/;

export interface DisposableClusterOptions {
  /** Directory holding initdb/postgres. Defaults to RAK_PG_BIN_DIR. */
  binDir?: string;
  /** Extra shared-library directory (LD_LIBRARY_PATH) for unpacked PostgreSQL builds. */
  libDir?: string;
}

export interface DisposableCluster {
  readonly dataDir: string;
  readonly port: number;
  /** Connection URL for a database on this throwaway cluster. */
  url(database?: string): string;
  /** Creates a database named rak_t_<suffix>; returns its name. */
  createDatabase(suffix: string): Promise<string>;
  dropDatabase(database: string): Promise<void>;
  /** Applies packages/db migrations with `prisma migrate deploy`. */
  migrate(database: string): Promise<void>;
  /** Restarts the PostgreSQL server itself (fast shutdown, then start). */
  restartServer(): Promise<void>;
  stop(): Promise<void>;
}

export function postgresAvailable(options: DisposableClusterOptions = {}): boolean {
  return Boolean(options.binDir ?? process.env.RAK_PG_BIN_DIR);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const pool = new Pool({
      connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
      max: 1,
    });
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
}

/**
 * Starts a private PostgreSQL cluster in a temp directory, bound to 127.0.0.1 only.
 * It never connects to any pre-existing database server.
 */
export async function startDisposableCluster(
  options: DisposableClusterOptions = {},
): Promise<DisposableCluster> {
  const binDir = options.binDir ?? process.env.RAK_PG_BIN_DIR;
  if (!binDir) throw new Error("RAK_PG_BIN_DIR (PostgreSQL bin directory) is required");
  const libDir = options.libDir ?? process.env.RAK_PG_LIB_DIR;
  const env = {
    ...process.env,
    ...(libDir
      ? { LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
      : {}),
  };
  const root = await mkdtemp(path.join(tmpdir(), "rak-pg-"));
  const dataDir = path.join(root, "data");
  const port = await freePort();
  const bin = (name: string) => path.join(binDir, name);

  await execFileAsync(bin("initdb"), ["-D", dataDir, "-U", "postgres", "--auth=trust"], { env });

  let server: ChildProcess | undefined;
  const startServer = async () => {
    server = spawn(
      bin("postgres"),
      ["-D", dataDir, "-p", String(port), "-c", "listen_addresses=127.0.0.1", "-k", root, "-F"],
      { env, stdio: "ignore" },
    );
    await waitReady(port);
  };
  const stopServer = async () => {
    const current = server;
    if (!current || current.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      current.once("exit", () => resolve());
      current.kill("SIGINT"); // fast shutdown
    });
    server = undefined;
  };

  await startServer();
  const admin = () =>
    new Pool({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`, max: 1 });
  const url = (database = "postgres") => `postgres://postgres@127.0.0.1:${port}/${database}`;

  const assertName = (database: string) => {
    if (!DB_NAME.test(database)) {
      throw new Error(`Refusing to touch non-disposable database "${database}"`);
    }
  };

  return {
    dataDir,
    port,
    url,
    async createDatabase(suffix) {
      const database = `${DISPOSABLE_DB_PREFIX}${suffix}`;
      assertName(database);
      const pool = admin();
      try {
        await pool.query(`CREATE DATABASE "${database}"`);
      } finally {
        await pool.end();
      }
      return database;
    },
    async dropDatabase(database) {
      assertName(database);
      const pool = admin();
      try {
        await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      } finally {
        await pool.end();
      }
    },
    async migrate(database) {
      assertName(database);
      await execFileAsync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
        cwd: path.join(REPO_ROOT, "packages/db"),
        env: { ...env, DATABASE_URL: url(database) },
      });
    },
    async restartServer() {
      await stopServer();
      await startServer();
    },
    async stop() {
      await stopServer();
      await rm(root, { recursive: true, force: true });
    },
  };
}
