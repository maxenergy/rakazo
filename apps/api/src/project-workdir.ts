import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ORPCError } from "@orpc/server";

const exec = promisify(execFile);
const MAX_FILE = 256 * 1024;
const MAX_ENTRIES = 500;
const missing = () => new ORPCError("NOT_FOUND", { message: "Resource not found." });
const limited = () => new ORPCError("BAD_REQUEST", { message: "Read limit exceeded." });
// Conservative denylist: names such as .env.example and id_rsa.pub are also hidden.
function sensitive(name: string) {
  return (
    /^(\.git|\.npmrc|\.netrc|\.ssh|\.aws|\.azure|\.config|\.gnupg|\.kube|credentials?|secrets?)$/i.test(
      name,
    ) ||
    /^(\.env|id_rsa|id_dsa|id_ed25519|id_ecdsa)/i.test(name) ||
    /\.(pem|key|p12|pfx)$/i.test(name)
  );
}
function parts(relative: string) {
  // Apply Windows rules on every platform: no ADS, UNC, drive, backslash or alias segments.
  if (
    relative.length > 4096 ||
    /[\\:]/.test(relative) ||
    [...relative].some((char) => char.charCodeAt(0) < 32) ||
    path.posix.isAbsolute(relative)
  )
    throw missing();
  if (!relative || relative === ".") return [];
  const items = relative.split("/");
  if (
    items.some(
      (item) =>
        !item ||
        item === "." ||
        item === ".." ||
        /[. ]$/.test(item) ||
        sensitive(item) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(item),
    )
  )
    throw missing();
  return items;
}
function contained(root: string, candidate: string) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}
export async function resolveProjectPath(
  homesRoot: string | undefined,
  spaceId: string,
  binding: string,
  relative = "",
) {
  if (!homesRoot || !/^[a-zA-Z0-9_-]+$/.test(spaceId)) throw missing();
  const base = path.resolve(homesRoot);
  const segments = [`team-${spaceId}`, ...parts(binding), ...parts(relative)];
  let current = base;
  const baseStat = await lstat(base).catch(() => {
    throw missing();
  });
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw missing();
  const canonicalBase = await realpath(base);
  let root = "";
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch(() => {
      throw missing();
    });
    // Node reports Windows junctions as symbolic links. Reject file hard links on both platforms.
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
      throw missing();
    const canonical = await realpath(current);
    if (!contained(canonicalBase, canonical) || (root && !contained(root, canonical)))
      throw missing();
    if (!root) root = canonical;
  }
  return current;
}
export async function browseProjectDirectory(
  homesRoot: string | undefined,
  spaceId: string,
  binding: string,
  relative: string,
) {
  const directory = await resolveProjectPath(homesRoot, spaceId, binding, relative);
  const handle = await opendir(directory).catch(() => {
    throw missing();
  });
  const entries: { name: string; type: "directory" | "file"; size: number }[] = [];
  let count = 0;
  for await (const entry of handle) {
    if (++count > MAX_ENTRIES) throw limited();
    if (sensitive(entry.name)) continue;
    try {
      parts(entry.name);
      const full = await resolveProjectPath(
        homesRoot,
        spaceId,
        binding,
        [relative === "." ? "" : relative, entry.name].filter(Boolean).join("/"),
      );
      const stat = await lstat(full);
      entries.push({
        name: entry.name,
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
      });
    } catch (error) {
      if (!(error instanceof ORPCError && error.code === "NOT_FOUND")) throw error;
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
export async function readProjectFile(
  homesRoot: string | undefined,
  spaceId: string,
  binding: string,
  relative: string,
) {
  const target = await resolveProjectPath(homesRoot, spaceId, binding, relative);
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
    throw missing();
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw missing();
    if (stat.size > MAX_FILE) throw limited();
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_FILE) throw limited();
    const bytes = buffer.subarray(0, total);
    if (bytes.includes(0)) throw new ORPCError("BAD_REQUEST", { message: "Text files only." });
    return { text: bytes.toString("utf8"), size: total };
  } finally {
    await file.close();
  }
}
export async function readProjectCommits(
  homesRoot: string | undefined,
  spaceId: string,
  binding: string,
) {
  const directory = await resolveProjectPath(homesRoot, spaceId, binding);
  // Git metadata is used only by this endpoint; never expose .git through file browsing.
  const git = path.join(directory, ".git");
  const stat = await lstat(git).catch(() => {
    throw missing();
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw missing();
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  });
  const { stdout } = await exec(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      "-c",
      "log.showSignature=false",
      "-C",
      directory,
      "log",
      "--no-ext-diff",
      "--no-textconv",
      "--no-decorate",
      "-20",
      "--format=%H%x00%aI%x00%an%x00%s%x00",
    ],
    { env, timeout: 3000, maxBuffer: 128 * 1024, windowsHide: true },
  ).catch(() => {
    throw missing();
  });
  const fields = stdout.trimEnd().split("\0");
  const commits = [];
  for (let i = 0; i + 3 < fields.length; i += 4)
    commits.push({
      sha: fields[i]!.trim(),
      authoredAt: fields[i + 1]!,
      author: fields[i + 2]!,
      subject: fields[i + 3]!,
    });
  return commits;
}

export async function getProjectWorkdir(
  db: {
    project: {
      findFirst: (input: {
        where: { id: string; spaceId: string };
        select: { workdirPath: true };
      }) => Promise<{ workdirPath: string | null } | null>;
    };
  },
  spaceId: string,
  projectId: string,
) {
  const row = await db.project.findFirst({
    where: { id: projectId, spaceId },
    select: { workdirPath: true },
  });
  if (!row) throw missing();
  return row.workdirPath;
}
