import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browseProjectDirectory,
  getProjectWorkdir,
  readProjectCommits,
  readProjectFile,
  resolveProjectPath,
} from "./project-workdir.js";

describe("project workdir", () => {
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "project-workdir-"));
    dir = path.join(root, "team-space", "repo");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "hello.txt"), "hello");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("reads ordinary files and directories", async () => {
    expect(await readProjectFile(root, "space", "repo", "hello.txt")).toEqual({
      text: "hello",
      size: 5,
    });
    expect(await browseProjectDirectory(root, "space", "repo", "")).toEqual([
      { name: "hello.txt", type: "file", size: 5 },
    ]);
  });
  it("rejects traversal, absolute paths and Windows aliases", async () => {
    for (const name of [
      "../hello.txt",
      "/etc/passwd",
      "C:/a",
      "hello.txt:secret",
      "a\\b",
      "hello.txt.",
      "CON",
    ]) {
      await expect(resolveProjectPath(root, "space", "repo", name)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
  });
  it("rejects symbolic links and hard links", async () => {
    await symlink(path.join(dir, "hello.txt"), path.join(dir, "sym"));
    await expect(readProjectFile(root, "space", "repo", "sym")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await link(path.join(dir, "hello.txt"), path.join(dir, "hard"));
    await expect(readProjectFile(root, "space", "repo", "hard")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("hides and refuses sensitive files", async () => {
    for (const name of [".env", ".env.local", "id_rsa.pub", "private.key", ".git", ".ssh"]) {
      await writeFile(path.join(dir, name), "secret");
      await expect(readProjectFile(root, "space", "repo", name)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    expect((await browseProjectDirectory(root, "space", "repo", "")).map((x) => x.name)).toEqual([
      "hello.txt",
    ]);
  });
  it("restricts space roots and project lookups", async () => {
    await expect(readProjectFile(root, "other", "repo", "hello.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const db = {
      project: {
        findFirst: async (input: unknown) => {
          expect(input).toEqual({
            where: { id: "project", spaceId: "other" },
            select: { workdirPath: true },
          });
          return null;
        },
      },
    };
    await expect(getProjectWorkdir(db, "other", "project")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("limits file size and rejects binary files", async () => {
    await writeFile(path.join(dir, "large"), Buffer.alloc(256 * 1024 + 1, 65));
    await expect(readProjectFile(root, "space", "repo", "large")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await writeFile(path.join(dir, "binary"), Buffer.from([0, 1]));
    await expect(readProjectFile(root, "space", "repo", "binary")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
  it("limits directory entries", async () => {
    await Promise.all(
      Array.from({ length: 500 }, (_, i) => writeFile(path.join(dir, String(i)), "")),
    );
    await expect(browseProjectDirectory(root, "space", "repo", "")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
  it("returns recent commit metadata", async () => {
    execFileSync("git", ["init", dir]);
    execFileSync("git", ["-C", dir, "add", "hello.txt"]);
    execFileSync("git", [
      "-C",
      dir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
    expect(await readProjectCommits(root, "space", "repo")).toEqual([
      expect.objectContaining({
        author: "Test",
        subject: "initial",
        sha: expect.stringMatching(/^[a-f0-9]{40}$/),
      }),
    ]);
  });
});
