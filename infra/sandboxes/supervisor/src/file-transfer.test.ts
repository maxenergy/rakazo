import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fileReadScript, fileWriteScript } from "./file-transfer.js";

it("reads a regular file through the checked fd and rejects a symlink", () => {
  const root = mkdtempSync(path.join(tmpdir(), "transfer-test-"));
  try {
    const source = path.join(root, "source");
    writeFileSync(source, "payload");
    symlinkSync(source, path.join(root, "link"));
    const run = (target: string) =>
      spawnSync(
        "python3",
        ["-c", fileReadScript(true).replaceAll("/home/rakazo", root), target, "10"],
        { encoding: "utf8" },
      );
    expect(run(source).stdout).toBe(Buffer.from("payload").toString("base64"));
    expect(run(path.join(root, "link")).status).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("creates exclusively and preserves an existing destination", () => {
  const root = mkdtempSync(path.join(tmpdir(), "transfer-test-"));
  try {
    const target = path.join(root, "target");
    const script = [
      "import os, sys",
      "target = sys.argv[1]",
      fileWriteScript(true).replaceAll("/home/rakazo", root),
    ].join("\n");
    const run = (input: string) =>
      spawnSync("python3", ["-c", script, target], { input, encoding: "utf8" });
    expect(run("payload").status).toBe(0);
    expect(run("replacement").status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("payload");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
