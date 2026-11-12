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
  readProjectImage,
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
  it.each([
    ["png", "89504e470d0a1a0a", "image/png"],
    ["jpeg", "ffd8ff", "image/jpeg"],
    ["gif87", "474946383761", "image/gif"],
    ["gif89", "474946383961", "image/gif"],
    ["webp", "524946460400000057454250", "image/webp"],
  ])("reads %s by signature despite a misleading extension", async (_, hex, mime) => {
    const bytes = Buffer.from(hex, "hex");
    await writeFile(path.join(dir, "image.txt"), bytes);
    expect(await readProjectImage(root, "space", "repo", "image.txt")).toEqual({
      mime,
      size: bytes.length,
      dataBase64: bytes.toString("base64"),
    });
  });
  it("rejects unknown signatures, SVG and incomplete signatures", async () => {
    for (const bytes of [
      Buffer.from("<svg></svg>"),
      Buffer.from("hello"),
      Buffer.from([137, 80]),
      Buffer.from("RIFFxxxxNOPE"),
      Buffer.from([199, 201, 198, 184, 185, 225]),
    ]) {
      await writeFile(path.join(dir, "image.png"), bytes);
      await expect(readProjectImage(root, "space", "repo", "image.png")).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Text files only.",
      });
    }
  });
  it("allows exactly 5 MiB and rejects larger images", async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024);
    Buffer.from([255, 216, 255]).copy(bytes);
    await writeFile(path.join(dir, "image"), bytes);
    expect((await readProjectImage(root, "space", "repo", "image")).size).toBe(bytes.length);
    await writeFile(path.join(dir, "image"), Buffer.concat([bytes, Buffer.from([0])]));
    await expect(readProjectImage(root, "space", "repo", "image")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Read limit exceeded.",
    });
  });
  it("applies file path and space restrictions to images", async () => {
    await symlink(path.join(dir, "hello.txt"), path.join(dir, "sym"));
    await link(path.join(dir, "hello.txt"), path.join(dir, "hard"));
    await writeFile(path.join(dir, ".env.png"), "hidden");
    for (const name of [
      "../hello.txt",
      "/etc/passwd",
      "hello.txt:secret",
      "sym",
      "hard",
      ".env.png",
    ]) {
      await expect(readProjectImage(root, "space", "repo", name)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    await expect(readProjectImage(root, "other", "repo", "hello.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
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
