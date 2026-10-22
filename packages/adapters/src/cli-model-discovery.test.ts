import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexModelCatalog } from "./cli-model-discovery.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function run(mode: string, timeout = 2000) {
  const root = await mkdtemp(join(tmpdir(), "rak48-discovery-"));
  roots.push(root);
  const file = join(root, "server.cjs");
  await writeFile(
    file,
    `
const readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
let initialized = false;
const send = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (mode === 'timeout') return;
  if (request.method === 'initialize') {
    if (mode === 'unsupported') return send({id: request.id, error: {code: -32601}});
    if (request.params.clientInfo.name !== 'rakazo') process.exit(2);
    return send({id: request.id, result: {}});
  }
  if (request.method === 'initialized') { initialized = true; return; }
  if (request.method !== 'model/list' || !initialized || 'includeHidden' in request.params) process.exit(3);
  if (mode === 'error') return send({id: request.id, error: {code: -32000}});
  if (mode === 'malformed') return send({id: request.id, result: {data: 'invalid'}});
  const model = {id: 'fixture', model: request.params.cursor ? 'second' : 'first', displayName: 'Fixture'};
  if (mode === 'pages' && !request.params.cursor) return send({id: request.id, result: {data: [model, {...model, model: 'hidden', hidden: true}], nextCursor: 'opaque/+ cursor'}});
  if (mode === 'pages' && request.params.cursor !== 'opaque/+ cursor') process.exit(4);
  send({id: request.id, result: {data: [model], nextCursor: mode === 'cycle' ? 'repeat' : null}});
});
`,
  );
  return readCodexModelCatalog({ file: process.execPath, prefix: [file] }, {}, timeout);
}

describe("Codex CLI discovery protocol", () => {
  it("terminates a timed-out server that ignores SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "rak48-cleanup-"));
    roots.push(root);
    const file = join(root, "server.cjs");
    const pidFile = join(root, "pid");
    await writeFile(
      file,
      `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    let pid: number | undefined;
    let cleanupError: unknown;
    try {
      const result = await readCodexModelCatalog(
        { file: process.execPath, prefix: [file] },
        {},
        1000,
      );
      pid = Number(await readFile(pidFile, "utf8"));
      expect(result).toEqual({ status: "static", models: null });
      await expect
        .poll(
          () => {
            try {
              process.kill(pid!, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
              throw error;
            }
          },
          { timeout: 2000 },
        )
        .toBe(true);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            cleanupError = error;
          }
        }
      }
    }
    if (cleanupError) throw cleanupError;
  });

  it("handshakes, follows opaque cursors, and excludes hidden models", async () => {
    const result = await run("pages");
    expect(result.status).toBe("discovered");
    expect(result.models?.map((model) => model.model)).toEqual(["first", "second"]);
  });
  it("preserves absent modalities as unknown evidence", async () => {
    const result = await run("success");
    expect(result.status).toBe("discovered");
    expect(result.models?.[0]?.inputModalities).toBeUndefined();
  });
  it.each(["unsupported", "error", "malformed", "cycle", "timeout"])(
    "falls back safely for %s",
    async (mode) => {
      expect(await run(mode, mode === "timeout" ? 100 : 2000)).toEqual({
        status: "static",
        models: null,
      });
    },
  );
});
