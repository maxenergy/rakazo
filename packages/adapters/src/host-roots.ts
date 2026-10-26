import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isAllowedDesktopPath, normalizeDesktopWorkspacePath } from "./desktop-sandbox-paths.js";

export function normalizeHostRoot(value: string, platform = process.platform): string {
  const ops = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    if (!/^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}/.test(value))
      throw new Error("Host roots must be absolute drive paths");
    for (const segment of value.slice(3).replaceAll("\\", "/").split("/").filter(Boolean)) {
      if (segment !== "." && segment !== "..") normalizeDesktopWorkspacePath(segment, "win32");
    }
  } else if (!ops.isAbsolute(value) || value.startsWith("//") || value.includes("\\"))
    throw new Error("Host roots must be absolute paths");
  const normalized = ops.resolve(value);
  const comparable = platform === "win32" ? normalized.toLowerCase() : normalized;
  if (comparable === ops.parse(comparable).root) throw new Error("A whole disk cannot be granted");
  const protectedRoots =
    platform === "win32"
      ? [
          `${ops.parse(comparable).root}windows`,
          `${ops.parse(comparable).root}program files`,
          `${ops.parse(comparable).root}program files (x86)`,
          `${ops.parse(comparable).root}programdata`,
        ]
      : [
          "/etc",
          "/bin",
          "/sbin",
          "/usr",
          "/var",
          "/proc",
          "/sys",
          "/dev",
          "/boot",
          "/System",
          "/Library",
          "/Applications",
          "/private",
        ];
  if (
    protectedRoots.some(
      (root) =>
        isAllowedDesktopPath(comparable, [root], ops) ||
        isAllowedDesktopPath(root, [comparable], ops),
    )
  )
    throw new Error("Protected system directories cannot be granted");
  return normalized;
}

export async function validateHostRoots(values: string[]): Promise<string[]> {
  if (values.length > 10) throw new Error("At most 10 host roots are allowed");
  const roots: string[] = [];
  for (const value of values) {
    const normalized = normalizeHostRoot(value);
    const resolved = normalizeHostRoot(await realpath(normalized));
    const same =
      process.platform === "win32"
        ? resolved.toLowerCase() === normalized.toLowerCase()
        : resolved === normalized;
    if (!same) throw new Error("Host roots cannot traverse symlinks or junctions");
    if (!(await stat(resolved)).isDirectory()) throw new Error("Host roots must be directories");
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}
