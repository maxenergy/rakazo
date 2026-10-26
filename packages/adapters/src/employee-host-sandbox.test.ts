import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { EmployeeHostSandbox } from "./employee-host-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { HostAwareSandbox, sandboxKindForBot } from "./host-aware-sandbox.js";

const ctx = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "owner",
  botId: "employee",
  runId: "run",
  signal: new AbortController().signal,
};
const paths: string[] = [];
afterEach(async () => {
  for (const root of paths.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await mkdtemp(path.join(tmpdir(), "employee-host-"));
  paths.push(value);
  return value;
}
function db() {
  return {
    hostAuditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit" }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}
describe("employee host runs", () => {
  it("routes by employee and does not read or mutate shared Computer rows", async () => {
    const home = await root();
    const prisma = {
      ...db(),
      bot: { findFirst: vi.fn().mockResolvedValue({ workLocation: "host", hostRoots: [home] }) },
      computer: { update: vi.fn(), findUnique: vi.fn() },
    };
    const isolated = new FakeSandboxProvider();
    const provision = vi.spyOn(isolated, "provision");
    const sandbox = new HostAwareSandbox(
      isolated,
      new DesktopSandboxProvider(),
      async () => false,
      { prisma: prisma as unknown as PrismaClient },
    );
    const ref = await sandbox.provision({ botId: "shared-home", homePath: "unused" }, ctx);
    expect(ref).toMatchObject({ kind: "desktop", botId: "employee", providerRef: home });
    expect(provision).not.toHaveBeenCalled();
    expect(prisma.computer.update).not.toHaveBeenCalled();
    expect(prisma.computer.findUnique).not.toHaveBeenCalled();
    await sandbox.writeFile(
      ref,
      { path: "result.txt", content: new TextEncoder().encode("host") },
      ctx,
    );
    expect(await readFile(path.join(home, "result.txt"), "utf8")).toBe("host");
    prisma.bot.findFirst.mockResolvedValue({ workLocation: "container", hostRoots: [] });
    const container = await sandbox.provision({ botId: "shared-home", homePath: home }, ctx);
    expect(container.kind).toBe("fake");
    expect(provision).toHaveBeenCalledOnce();
    expect(sandboxKindForBot("docker", "docker", "host")).toBe("desktop");
    expect(sandboxKindForBot("docker", "this-mac", "container")).toBe("desktop");
  });
  it("limits file tools and cwd to configured roots, rejects parent and symlink escapes, and audits attempts", async () => {
    const home = await root();
    const second = await root();
    const outside = await root();
    await mkdir(path.join(home, "inside"));
    await symlink(
      outside,
      path.join(home, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const prisma = db();
    const sandbox = new EmployeeHostSandbox(prisma as unknown as PrismaClient, {
      hostRoots: [home, second],
    });
    const ref = await sandbox.provision({ botId: ctx.botId, homePath: "" }, ctx);
    const file = (value: string) =>
      sandbox.writeFile(ref, { path: value, content: new TextEncoder().encode("ok") }, ctx);
    await file(path.join(second, "second.txt"));
    expect(await readFile(path.join(second, "second.txt"), "utf8")).toBe("ok");
    await expect(file(path.join(outside, "bad.txt"))).rejects.toThrow();
    await expect(file("../bad.txt")).rejects.toThrow();
    await expect(file("escape/bad.txt")).rejects.toThrow();
    await expect(sandbox.readFile(ref, path.join(outside, "bad.txt"), ctx)).rejects.toThrow();
    const run = async (cwd: string) => {
      const events = [];
      for await (const e of sandbox.execute(
        ref,
        { argv: [process.execPath, "-e", "process.stdout.write('ok')"], cwd },
        ctx,
      ))
        events.push(e);
      return events;
    };
    expect(await run(path.join(home, "inside"))).toContainEqual({ type: "exit", code: 0 });
    expect(await run(path.join(home, "escape"))).toContainEqual({ type: "exit", code: 1 });
    await expect(run("../")).rejects.toThrow("Parent traversal");
    expect(prisma.hostAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "employee", runId: "run", kind: "file_write" }),
      }),
    );
    expect(prisma.hostAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: "exec" }) }),
    );
  });
});
