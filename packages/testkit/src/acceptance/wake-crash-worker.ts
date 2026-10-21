import { claimTicketWakes, createDb } from "@rakazo/db";

// Started only by the disposable-PostgreSQL acceptance test.
const databaseUrl = process.env.RAK_CRASH_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Missing disposable database URL");
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^rak_t_[a-z0-9_]{1,40}$/.test(databaseName)) {
  throw new Error("Crash worker requires a disposable database");
}
const db = createDb(databaseUrl);
const claimed = await claimTicketWakes(db.prisma, "crashed-process", {
  leaseMs: 60_000,
});
if (claimed.length !== 1) throw new Error("Expected exactly one durable wake");
process.stdout.write(`${JSON.stringify({ pid: process.pid, claimed })}
`);
// The parent deliberately kills this process without running cleanup.
setInterval(() => {}, 1_000);
