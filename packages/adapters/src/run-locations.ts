import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { hasActiveBackgroundWork } from "./computer-idle.js";
import { isAllowedDesktopPath } from "./desktop-sandbox-paths.js";
import { normalizeHostRoot, validateHostRoots } from "./host-roots.js";

export type WorkLocation = "host" | "container";
export const LOCATION_TOOL_NAMES = new Set([
  "shell",
  "list_files",
  "read_file",
  "write_file",
  "attach_file",
  "open_path",
  "launch_app",
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "render_plot",
]);
export function explicitLocation(value: unknown): WorkLocation {
  if (value !== "host" && value !== "container")
    throw new Error("location must be explicitly host or container");
  return value;
}

const MAX_TRANSFER_BYTES = 10 * 1024 * 1024;

/** One session per run segment. Ref selection never updates stored computers or workspaces. */
export class RunLocations {
  private readonly refs = new Map<WorkLocation, ComputerRef>();
  private active: WorkLocation;
  private busy = false;
  private readonly completions = new Set<Promise<unknown>>();

  constructor(
    private readonly options: {
      sandbox: SandboxProvider;
      prisma: PrismaClient;
      context: AdapterContext;
      initial: ComputerRef;
      initialLocation: WorkLocation;
      markerId: string;
      containerHome: string;
      hostRoots: string[];
      provisionContainer?: () => Promise<ComputerRef>;
    },
  ) {
    this.active = options.initialLocation;
    this.refs.set(this.active, options.initial);
  }

  private audit(
    kind: "location_switch" | "file_transfer",
    target: string,
    exitCode: number | null,
  ) {
    const { prisma, context } = this.options;
    return prisma.hostAuditLog.create({
      data: {
        botId: context.botId!,
        runId: context.runId,
        userId: context.userId,
        kind,
        target,
        exitCode,
      },
    });
  }

  private async authorizeHost() {
    const { prisma, context, hostRoots } = this.options;
    const bot = await prisma.bot.findFirst({
      where: {
        id: context.botId,
        spaceId: context.spaceId,
        userId: context.userId,
        archivedAt: null,
      },
      select: {
        workLocation: true,
        hostGrantedAt: true,
        hostGrantedByUserId: true,
        hostRoots: true,
      },
    });
    if (
      !bot ||
      bot.workLocation !== "host" ||
      !bot.hostGrantedAt ||
      !bot.hostGrantedByUserId ||
      hostRoots.length !== bot.hostRoots.length ||
      hostRoots.some((root, index) => root !== bot.hostRoots[index])
    ) {
      throw new Error("Host authorization was revoked or changed; new host calls are refused");
    }
  }

  track(completion: Promise<unknown>) {
    this.completions.add(completion);
    void completion.finally(() => this.completions.delete(completion)).catch(() => undefined);
  }

  private async select(location: WorkLocation): Promise<ComputerRef> {
    const { sandbox, context, markerId } = this.options;
    if (location === "host") await this.authorizeHost();
    if (location !== this.active) {
      if (
        this.completions.size ||
        (await hasActiveBackgroundWork(sandbox, this.refs.get(this.active)!, context, markerId))
      ) {
        throw new Error("A process is still in flight; finish it before switching location");
      }
    }
    let ref = this.refs.get(location);
    if (!ref) {
      if (!sandbox.provisionLocation)
        throw new Error("This deployment does not support the requested location");
      const roots = location === "host" ? await validateHostRoots(this.options.hostRoots) : [];
      if (location === "host" && !roots.length)
        throw new Error("Explicit host roots are required for sequential calls");
      ref =
        location === "container" && this.options.provisionContainer
          ? await this.options.provisionContainer()
          : await sandbox.provisionLocation(
              {
                location,
                botId: context.botId!,
                homePath: this.options.containerHome,
                hostRoots: roots,
              },
              context,
            );
      // Capture before prepare so failed setup is still released.
      this.refs.set(location, ref);
      await sandbox.prepare(ref, context);
    }
    if (location !== this.active) {
      await this.audit("location_switch", JSON.stringify({ from: this.active, to: location }), 0);
      this.active = location;
    }
    return ref;
  }

  async call<T>(
    locationValue: unknown,
    action: (ref: ComputerRef, location: WorkLocation) => Promise<T>,
  ): Promise<T> {
    const location = explicitLocation(locationValue);
    if (this.busy) {
      await this.audit(
        "location_switch",
        JSON.stringify({ to: location, error: "Concurrent calls are not allowed" }),
        1,
      );
      throw new Error("Computer calls must run sequentially");
    }
    this.busy = true;
    try {
      let ref: ComputerRef;
      try {
        ref = await this.select(location);
      } catch (error) {
        await this.audit(
          "location_switch",
          JSON.stringify({ to: location, error: String(error) }),
          1,
        );
        throw error;
      }
      return await action(ref, location);
    } finally {
      this.busy = false;
    }
  }

  async transfer(args: Record<string, unknown>, resolveContainerPath: (value: string) => string) {
    const source = explicitLocation(args.sourceLocation);
    const target = explicitLocation(args.targetLocation);
    const detail = JSON.stringify({
      sourceLocation: source,
      targetLocation: target,
      sourcePath: args.sourcePath,
      targetPath: args.targetPath,
      exchangeDirectory: args.exchangeDirectory,
    });
    const entry = await this.audit("file_transfer", detail, null);
    let locked = false;
    try {
      if (source === target) throw new Error("A transfer must cross locations");
      if (this.busy) throw new Error("Computer calls must run sequentially");
      this.busy = true;
      locked = true;
      await this.authorizeHost();
      const roots = await validateHostRoots(this.options.hostRoots);
      const exchange = String(args.exchangeDirectory ?? "");
      if (/(^|[/\\])\.\.([/\\]|$)/u.test(exchange))
        throw new Error("Parent traversal is not allowed");
      const normalized = normalizeHostRoot(exchange);
      const resolved = await realpath(normalized);
      if (
        normalized !== resolved ||
        !roots.some((root) => isAllowedDesktopPath(resolved, [root])) ||
        !(await stat(resolved)).isDirectory()
      )
        throw new Error("Exchange directory must be a real directory inside host roots");
      const sourcePath = String(args.sourcePath ?? "");
      const targetPath = String(args.targetPath ?? "");
      for (const value of [sourcePath, targetPath]) {
        if (!value || /(^|[/\\])\.\.([/\\]|$)/u.test(value) || /^[\\/]{2}/u.test(value)) {
          throw new Error("Invalid transfer path");
        }
      }
      const hostPath = source === "host" ? sourcePath : targetPath;
      const normalizedHostPath = normalizeHostRoot(hostPath);
      const resolvedParent = await realpath(path.dirname(normalizedHostPath));
      if (
        resolvedParent !== path.dirname(normalizedHostPath) ||
        !isAllowedDesktopPath(resolvedParent, [resolved])
      )
        throw new Error("Host file must be inside the exchange directory without junctions");
      const from = await this.select(source);
      const fromPath = source === "host" ? sourcePath : resolveContainerPath(sourcePath);
      const content = await this.options.sandbox.readFile(from, fromPath, this.options.context, {
        maxBytes: MAX_TRANSFER_BYTES,
      });
      if (content.byteLength > MAX_TRANSFER_BYTES) throw new Error("Transfer exceeds 10 MiB");
      const to = await this.select(target);
      const toPath = target === "host" ? targetPath : resolveContainerPath(targetPath);
      const parent = target === "host" ? path.dirname(toPath) : path.posix.dirname(toPath);
      const basename = target === "host" ? path.basename(toPath) : path.posix.basename(toPath);
      const entries = await this.options.sandbox.listFiles(to, parent, this.options.context);
      if (
        entries.some(
          (entry) =>
            entry.path === basename ||
            entry.path === toPath ||
            path.posix.basename(entry.path) === basename,
        )
      ) {
        throw new Error("Transfer destination already exists");
      }
      // Revocation may have happened while reading the other location.
      await this.authorizeHost();
      await this.options.sandbox.writeFile(to, { path: toPath, content }, this.options.context);
      const written = await this.options.sandbox.readFile(to, toPath, this.options.context, {
        maxBytes: MAX_TRANSFER_BYTES,
      });
      const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      if (digest(written) !== digest(content)) throw new Error("Transfer integrity check failed");
      await this.options.prisma.hostAuditLog.update({
        where: { id: entry.id },
        data: { exitCode: 0 },
      });
      return {
        ok: true,
        bytes: content.byteLength,
        sha256: digest(content),
        sourceLocation: source,
        targetLocation: target,
      };
    } catch (error) {
      await this.options.prisma.hostAuditLog.update({
        where: { id: entry.id },
        data: { exitCode: 1 },
      });
      throw error;
    } finally {
      if (locked) this.busy = false;
    }
  }

  containerRef() {
    return this.refs.get("container");
  }

  async release() {
    for (const ref of this.refs.values()) {
      if (ref !== this.options.initial) {
        await this.options.sandbox
          .releaseScreen?.(ref, this.options.context)
          .catch(() => undefined);
      }
    }
  }
}
