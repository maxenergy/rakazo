import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeHostRoot, validateHostRoots } from "./host-roots.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("host roots", () => {
  it("normalizes absolute Windows drive paths", () => {
    expect(normalizeHostRoot("C:/Users/Test/projects/../work", "win32")).toBe(
      "C:\\Users\\Test\\work",
    );
  });
  it.each([
    "C:\\",
    "C:/Windows/System32",
    "c:/PROGRAM FILES/app",
    "C:relative",
    "\\\\server\\share",
    "\\\\?\\C:\\Users",
    "\\\\.\\C:",
    "C:/Users/NUL",
    "C:/Users/test:stream",
  ])("rejects unsafe Windows root %s", (value) => {
    expect(() => normalizeHostRoot(value, "win32")).toThrow();
  });
  it.each(["/", "/etc", "/etc/ssh", "/usr/local", "relative", "//server/share"])(
    "rejects unsafe POSIX root %s",
    (value) => expect(() => normalizeHostRoot(value, "linux")).toThrow(),
  );
  it("requires existing directories and rejects symlink traversal", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "host-roots-"));
    temporary.push(dir);
    const real = path.join(dir, "real");
    await mkdir(real);
    expect(await validateHostRoots([real])).toEqual([real]);
    const linked = path.join(dir, "linked");
    await symlink(real, linked, "junction");
    await expect(validateHostRoots([linked])).rejects.toThrow(/symlinks|junctions/);
    await expect(validateHostRoots([path.join(dir, "missing")])).rejects.toThrow();
    const file = path.join(dir, "file");
    await writeFile(file, "");
    await expect(validateHostRoots([file])).rejects.toThrow(/directories/);
    await expect(validateHostRoots(Array(11).fill(real))).rejects.toThrow(/10/);
  });
});
