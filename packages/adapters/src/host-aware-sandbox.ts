import { homedir } from "node:os";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { EmployeeHostSandbox } from "./employee-host-sandbox.js";
import { createSandboxProvider, type SandboxProviderOptions } from "./sandbox-factory.js";

export function sandboxKindForBot(
  envKind: string,
  computerHost: string | null | undefined,
  workLocation?: string,
) {
  if (envKind === "docker" && (computerHost === "this-mac" || workLocation === "host"))
    return "desktop";
  return envKind;
}

export function createRunSandbox(
  kind: string,
  opts: SandboxProviderOptions & { prisma?: PrismaClient },
): SandboxProvider {
  if (kind === "desktop") {
    return opts.prisma
      ? new EmployeeHostSandbox(opts.prisma, {
          root: opts.dataDir,
          hostRoots: [homedir()],
          legacy: true,
        })
      : new DesktopSandboxProvider({ root: opts.dataDir, hostRoots: [homedir()] });
  }
  const primary = createSandboxProvider(kind, opts);
  if (kind !== "docker" || !opts.prisma) return primary;
  return new HostAwareSandbox(
    primary,
    new EmployeeHostSandbox(opts.prisma, {
      root: opts.dataDir,
      hostRoots: [homedir()],
      legacy: true,
    }),
    async () => {
      const settings = await opts.prisma!.deploymentSettings.findUnique({
        where: { id: "default" },
      });
      return settings?.computerHost === "this-mac";
    },
    { prisma: opts.prisma, dataDir: opts.dataDir },
  );
}

export class HostAwareSandbox implements SandboxProvider {
  private readonly employeeHosts = new Map<string, SandboxProvider>();
  readonly pageBrowser?: SandboxProvider["pageBrowser"];

  constructor(
    private readonly isolated: SandboxProvider,
    private readonly host: SandboxProvider,
    private readonly hostEnabled: () => Promise<boolean>,
    private readonly employeeOptions?: { prisma: PrismaClient; dataDir?: string },
  ) {
    if (isolated.pageBrowser || host.pageBrowser) {
      this.pageBrowser = (computer, request, context) => {
        const provider = this.route(computer);
        return provider.pageBrowser
          ? provider.pageBrowser(computer, request, context)
          : Promise.resolve({
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            });
      };
    }
  }

  describe() {
    return this.isolated.describe();
  }

  private route(computer: ComputerRef) {
    if (computer.id.startsWith("employee-host-") && !this.employeeHosts.has(computer.id)) {
      throw new Error("Employee host run is no longer active");
    }
    return (
      this.employeeHosts.get(computer.id) ??
      (computer.kind === "desktop" ? this.host : this.isolated)
    );
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ) {
    const bot =
      context.botId && this.employeeOptions
        ? await this.employeeOptions.prisma.bot.findFirst({
            where: { id: context.botId, spaceId: context.spaceId },
            select: { workLocation: true, hostRoots: true },
          })
        : null;
    if (bot?.workLocation === "host") {
      const provider = new EmployeeHostSandbox(this.employeeOptions!.prisma, {
        hostRoots: bot.hostRoots.length ? bot.hostRoots : [homedir()],
      });
      const ref = await provider.provision({ ...request, botId: context.botId! }, context);
      ref.id = `employee-host-${context.botId}-${context.runId ?? context.operationId}`;
      this.employeeHosts.set(ref.id, provider);
      return ref;
    }
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    const providerKind = provider.describe().id;
    return provider.provision(
      {
        ...request,
        providerRef: request.providerKind === providerKind ? request.providerRef : undefined,
      },
      context,
    );
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    const provider =
      this.employeeHosts.get(computer.id) ??
      ((await this.hostEnabled()) ? this.host : this.isolated);
    if (provider.describe().id !== computer.kind) return false;
    return provider.isRunning?.(computer, context) ?? false;
  }

  prepare(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* this.route(computer).execute(computer, request, context);
  }

  connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return this.route(computer).connectScreen(computer, request, context);
  }

  connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const provider = this.route(computer);
    if (!provider.connectTerminal) {
      return Promise.reject(new Error("terminal is unavailable on this computer"));
    }
    return provider.connectTerminal(computer, request, context);
  }

  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return this.route(computer).sendInput(computer, input, lease, context);
  }

  observe(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).observe(computer, context);
  }

  act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.route(computer).act(computer, request, context);
  }

  listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return this.route(computer).listFiles(computer, path, context);
  }

  readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return this.route(computer).readFile(computer, path, context, options);
  }

  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return this.route(computer).writeFile(computer, file, context);
  }

  exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).exportWorkspace(computer, context);
  }

  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return this.route(computer).importWorkspace(computer, files, context);
  }

  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).snapshot(computer, context);
  }

  keepAlive(computer: ComputerRef) {
    return this.route(computer).keepAlive?.(computer) ?? Promise.resolve();
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    try {
      await this.route(computer).releaseScreen?.(computer, context);
    } finally {
      this.employeeHosts.delete(computer.id);
    }
  }

  setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    return (
      this.route(computer).setScreenControl?.(computer, interactive, context, controlToken) ??
      Promise.resolve()
    );
  }

  stop(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).stop(computer, context);
  }

  destroy(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).destroy(computer, context);
  }
}
