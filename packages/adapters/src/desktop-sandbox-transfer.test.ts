import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";

it("rejects transfer symlinks and existing destinations while copying ordinary files", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "transfer-")));
  const context = {
    operationId: "op",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  };
  const provider = new DesktopSandboxProvider({ root });
  const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
  try {
    const home = provider.boxes.get(computer.id)!.home;
    await writeFile(path.join(home, "source"), "payload");
    await symlink(path.join(home, "source"), path.join(home, "link"));
    await expect(
      provider.readFile(computer, "link", context, { noFollow: true, maxBytes: 10 }),
    ).rejects.toThrow();
    const content = await provider.readFile(computer, "source", context, {
      noFollow: true,
      maxBytes: 10,
    });
    await provider.writeFile(computer, { path: "target", content }, context, { exclusive: true });
    expect(await readFile(path.join(home, "target"), "utf8")).toBe("payload");
    await expect(
      provider.writeFile(computer, { path: "target", content: new Uint8Array([0]) }, context, {
        exclusive: true,
      }),
    ).rejects.toThrow();
    expect(await readFile(path.join(home, "target"), "utf8")).toBe("payload");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
