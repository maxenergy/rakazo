import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { RunLocations } from "./run-locations.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "locations-")));
  dirs.push(root);
  const exchange = path.join(root, "exchange");
  await mkdir(exchange);
  const initial = {
    id: "container",
    providerRef: "container",
    botId: "bot",
    kind: "docker",
  } as ComputerRef;
  const host = { ...initial, id: "host", kind: "desktop" } as ComputerRef;
  const grant = {
    workLocation: "host",
    hostRoots: [root],
    hostGrantedAt: new Date(),
    hostGrantedByUserId: "user",
  };
  const prisma = {
    bot: { findFirst: vi.fn(async () => grant) },
    hostAuditLog: { create: vi.fn(async () => ({ id: "audit" })), update: vi.fn(async () => ({})) },
  };
  const data = new TextEncoder().encode("payload");
  const sandbox = {
    supportsSecureFileTransfer: vi.fn(async () => true),
    provisionLocation: vi.fn(async () => host),
    prepare: vi.fn(),
    inspectBackgroundWork: vi.fn(async () => "idle"),
    readFile: vi.fn(async () => data),
    writeFile: vi.fn(),
    listFiles: vi.fn(async () => []),
  };
  const session = new RunLocations({
    sandbox: sandbox as unknown as SandboxProvider,
    prisma: prisma as unknown as PrismaClient,
    context: {
      botId: "bot",
      runId: "run",
      spaceId: "space",
      userId: "user",
      operationId: "op",
      traceId: "trace",
      signal: new AbortController().signal,
    } as AdapterContext,
    initial,
    initialLocation: "container",
    markerId: "container",
    containerHome: "",
    hostRoots: [root],
  });
  const args = {
    sourceLocation: "container",
    targetLocation: "host",
    sourcePath: "source",
    targetPath: path.join(exchange, "target"),
    exchangeDirectory: exchange,
  };
  return { session, sandbox, prisma, grant, root, exchange, initial, host, args };
}
describe("sequential run locations", () => {
  it("requires explicit location in schemas and execution", async () => {
    const { session } = await fixture();
    await expect(session.call(undefined, vi.fn())).rejects.toThrow("explicitly");
    for (const name of ["shell", "read_file", "write_file"]) {
      const tool = builtinAgentTools.find((t) => t.name === name)!;
      expect(tool.inputSchema.required).toContain("location");
    }
  });
  it("routes container-host-container without replacing either workspace", async () => {
    const { session, initial, host, sandbox, prisma } = await fixture();
    const seen: ComputerRef[] = [];
    for (const location of ["container", "host", "container"])
      await session.call(location, async (ref) => {
        seen.push(ref);
      });
    expect(seen).toEqual([initial, host, initial]);
    expect(sandbox.provisionLocation).toHaveBeenCalledTimes(1);
    expect(prisma.hostAuditLog.create).toHaveBeenCalledTimes(2);
  });
  it("rejects and audits a switch with background work", async () => {
    const { session, sandbox, prisma } = await fixture();
    sandbox.inspectBackgroundWork.mockResolvedValue("active");
    await expect(session.call("host", vi.fn())).rejects.toThrow("in flight");
    expect(sandbox.provisionLocation).not.toHaveBeenCalled();
    expect(prisma.hostAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "location_switch", exitCode: 1 }),
      }),
    );
  });
  it("allows an in-flight action to finish after revocation, then refuses a new host call", async () => {
    const { session, grant, prisma } = await fixture();
    await expect(
      session.call("host", async () => {
        grant.workLocation = "container";
        return "finished";
      }),
    ).resolves.toBe("finished");
    const action = vi.fn();
    await expect(session.call("host", action)).rejects.toThrow("revoked");
    expect(action).not.toHaveBeenCalled();
    expect(prisma.hostAuditLog.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ exitCode: 1 }) }),
    );
  });
  it("refuses a switch while a returned shell completion is pending", async () => {
    const { session } = await fixture();
    let resolve!: () => void;
    session.track(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    await expect(session.call("host", vi.fn())).rejects.toThrow("in flight");
    resolve();
    await Promise.resolve();
    await expect(session.call("host", async () => "ok")).resolves.toBe("ok");
  });
  it("rejects providers without secure transfer support", async () => {
    const { session, sandbox, args } = await fixture();
    sandbox.supportsSecureFileTransfer.mockResolvedValue(false);
    await expect(session.transfer(args, (p) => p)).rejects.toThrow("does not support");
    expect(sandbox.readFile).not.toHaveBeenCalled();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });
  it("transfers bytes and records a successful audit", async () => {
    const { session, args, sandbox, prisma } = await fixture();
    const result = await session.transfer(args, (p) => p);
    expect(result).toMatchObject({
      ok: true,
      bytes: 7,
      sourceLocation: "container",
      targetLocation: "host",
    });
    expect(result.sha256).toHaveLength(64);
    expect(sandbox.writeFile).toHaveBeenCalledTimes(1);
    expect(prisma.hostAuditLog.update).toHaveBeenLastCalledWith({
      where: { id: "audit" },
      data: { exitCode: 0 },
    });
  });
  it("rejects traversal, outside roots, symlink directories and existing destinations with audit", async () => {
    const { session, args, root, exchange, sandbox, prisma } = await fixture();
    await symlink(exchange, path.join(root, "link"), "dir");
    for (const exchangeDirectory of [
      exchange + "/../exchange",
      path.dirname(root),
      path.join(root, "link"),
      "//server/share",
      "/",
    ]) {
      await expect(session.transfer({ ...args, exchangeDirectory }, (p) => p)).rejects.toThrow();
    }
    sandbox.writeFile.mockRejectedValue(new Error("destination already exists"));
    await expect(session.transfer(args, (p) => p)).rejects.toThrow("already exists");
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { exclusive: true },
    );
    expect(prisma.hostAuditLog.update).toHaveBeenLastCalledWith({
      where: { id: "audit" },
      data: { exitCode: 1 },
    });
  });
});
