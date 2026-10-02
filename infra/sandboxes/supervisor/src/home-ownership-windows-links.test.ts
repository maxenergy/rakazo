import type * as Fs from "node:fs/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertComputerHomeWritable } from "./home-ownership.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    lstat: async (target: string) => {
      if (path.basename(target) === "runtime-link") {
        throw Object.assign(new Error("EACCES: runtime metadata unavailable"), { code: "EACCES" });
      }
      return actual.lstat(target);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "win32")("Windows container runtime links", () => {
  it("skips a child symlink whose Linux reparse metadata cannot be read", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-runtime-link-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    await mkdir(home);
    await symlink(path.join(parent, "outside"), path.join(home, "runtime-link"));
    await expect(assertComputerHomeWritable(home, 1000, 1000)).resolves.toBeUndefined();
  });

  it("still rejects inaccessible metadata on an ordinary file", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "rakazo-runtime-file-"));
    roots.push(home);
    await writeFile(path.join(home, "runtime-link"), "fixture");
    await expect(assertComputerHomeWritable(home, 1000, 1000)).rejects.toThrow(/EACCES/);
  });
});
