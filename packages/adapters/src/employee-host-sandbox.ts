import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  PortableFile,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { isAllowedDesktopPath, normalizeDesktopWorkspacePath } from "./desktop-sandbox-paths.js";

/**
 * hostRoots constrains tool paths and shell cwd at the application layer.
 * Shell commands retain the OS permissions of the API process user; this is not an OS sandbox.
 */
export class EmployeeHostSandbox extends DesktopSandboxProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: { hostRoots: string[]; legacy?: boolean; root?: string },
  ) {
    super({ ...config, employeeHost: !config.legacy });
  }

  private async fileTarget(computer: ComputerRef, value: string) {
    if (/(^|[/\\])\.\.([/\\]|$)/u.test(value)) throw new Error("Parent traversal is not allowed");
    const absolute = path.isAbsolute(value)
      ? value
      : path.resolve(this.config.hostRoots[0]!, normalizeDesktopWorkspacePath(value));
    const root = this.config.hostRoots.find((candidate) =>
      isAllowedDesktopPath(absolute, [candidate]),
    );
    if (!root) throw new Error("Path is outside host roots");
    const resolvedRoot = await realpath(root);
    if (!isAllowedDesktopPath(resolvedRoot, [root])) throw new Error("Host root changed");
    const relative = normalizeDesktopWorkspacePath(path.relative(root, absolute));
    // DesktopSandboxProvider checks each existing component and holds parent handles for writes.
    return {
      computer: {
        ...computer,
        id: `${computer.id}:${root}`,
        botId: `${computer.id}:${root}`,
        providerRef: root,
      },
      relative,
    };
  }

  private audit(
    context: AdapterContext,
    kind: "exec" | "file_write" | "file_delete",
    target: string,
    command: string | null,
    exitCode: number | null,
  ) {
    return this.prisma.hostAuditLog.create({
      data: {
        botId: context.botId!,
        runId: context.runId ?? null,
        userId: context.userId,
        kind,
        target,
        command: command === null ? null : truncateHostAuditCommand(command),
        exitCode,
      },
    });
  }

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    let exitCode: number | null = null;
    // Persist the attempt before starting a command; retain it even if the run stops.
    const entry = await this.audit(
      context,
      "exec",
      request.cwd ?? this.config.hostRoots[0]!,
      request.argv.includes("rakazo-background-launch")
        ? request.argv.at(-1)!
        : request.argv.join(" "),
      null,
    );
    try {
      for await (const event of super.execute(computer, request, context)) {
        if (event.type === "exit") exitCode = event.code;
        yield event;
      }
    } finally {
      await this.prisma.hostAuditLog.update({ where: { id: entry.id }, data: { exitCode } });
    }
  }

  override async listFiles(computer: ComputerRef, directory: string, context: AdapterContext) {
    if (this.config.legacy) return super.listFiles(computer, directory, context);
    const target = await this.fileTarget(computer, directory);
    return super.listFiles(target.computer, target.relative, context);
  }

  override async readFile(
    computer: ComputerRef,
    filePath: string,
    context?: AdapterContext,
    options?: { maxBytes?: number; noFollow?: boolean },
  ) {
    if (this.config.legacy) return super.readFile(computer, filePath, context, options);
    const target = await this.fileTarget(computer, filePath);
    return super.readFile(target.computer, target.relative, context, options);
  }

  override async writeFile(
    computer: ComputerRef,
    file: PortableFile,
    context?: AdapterContext,
    options?: { exclusive?: boolean },
  ) {
    if (!context) throw new Error("Host writes require run context");
    const entry = await this.audit(context, "file_write", file.path, null, null);
    try {
      const target = this.config.legacy
        ? { computer, relative: file.path }
        : await this.fileTarget(computer, file.path);
      await super.writeFile(target.computer, { ...file, path: target.relative }, context, options);
      await this.prisma.hostAuditLog.update({ where: { id: entry.id }, data: { exitCode: 0 } });
    } catch (error) {
      await this.prisma.hostAuditLog.update({ where: { id: entry.id }, data: { exitCode: 1 } });
      throw error;
    }
  }
}

function truncateHostAuditCommand(command: string): string {
  let result = "";
  for (const character of command) {
    if (Buffer.byteLength(result + character) > 2048) break;
    result += character;
  }
  return result;
}
