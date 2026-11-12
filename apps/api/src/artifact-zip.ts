import { inflateRawSync } from "node:zlib";
import { ORPCError } from "@orpc/server";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { IsolationError, type PrismaClient } from "@rakazo/db";

export const ZIP_LIMITS = {
  archive: 10 * 1024 * 1024,
  entries: 500,
  entry: 1024 * 1024,
  total: 8 * 1024 * 1024,
};
const unsupported = () =>
  new ORPCError("BAD_REQUEST", { message: "Unsupported, invalid or oversized ZIP archive." });
type Entry = {
  path: string;
  size: number;
  compressedSize: number;
  directory: boolean;
  offset: number;
  method: number;
  crc: number;
};

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function safeName(name: string) {
  const clean = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    !clean ||
    name.length > 4096 ||
    /[\\:]/.test(name) ||
    name.startsWith("/") ||
    [...name].some((c) => c.charCodeAt(0) < 32) ||
    clean.split("/").some((x) => !x || x === "." || x === "..")
  )
    throw unsupported();
}
function decodeName(bytes: Buffer, flags: number) {
  // Non-UTF8 ZIP names are accepted only when ASCII, avoiding platform-dependent decoding.
  if (!(flags & 0x800) && bytes.some((x) => x >= 128)) throw unsupported();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw unsupported();
  }
}
function parse(bytes: Buffer): Entry[] {
  if (bytes.length > ZIP_LIMITS.archive || bytes.length < 22) throw unsupported();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw unsupported();
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const central = bytes.readUInt32LE(end + 16);
  if (
    count > ZIP_LIMITS.entries ||
    bytes.readUInt16LE(end + 8) !== count ||
    central + centralSize !== end
  )
    throw unsupported();
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let position = central;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) throw unsupported();
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const size = bytes.readUInt32LE(position + 24);
    const compressedSize = bytes.readUInt32LE(position + 20);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const offset = bytes.readUInt32LE(position + 42);
    const mode = bytes.readUInt32LE(position + 38) >>> 16;
    total += size;
    // Only store/deflate, UTF8 and data-descriptor flags. Reject encryption, split archives and special files.
    if (
      flags & ~0x80e ||
      (method !== 0 && method !== 8) ||
      bytes.readUInt16LE(position + 34) ||
      (mode & 0xf000) === 0xa000 ||
      (mode & 0xf000 && ![0x8000, 0x4000].includes(mode & 0xf000)) ||
      size > ZIP_LIMITS.entry ||
      total > ZIP_LIMITS.total
    )
      throw unsupported();
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw unsupported();
    const rawName = bytes.subarray(position + 46, position + 46 + nameLength);
    const name = decodeName(rawName, flags);
    safeName(name);
    if (seen.has(name)) throw unsupported();
    seen.add(name);
    // Check the local header too, before any decompression. ZIP64 is intentionally unsupported.
    if (
      offset + 30 > central ||
      bytes.readUInt32LE(offset) !== 0x04034b50 ||
      bytes.readUInt16LE(offset + 6) !== flags ||
      bytes.readUInt16LE(offset + 8) !== method
    )
      throw unsupported();
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const localExtraLength = bytes.readUInt16LE(offset + 28);
    const data = offset + 30 + localNameLength + localExtraLength;
    if (
      data + compressedSize > central ||
      !bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(rawName)
    )
      throw unsupported();
    const crc = bytes.readUInt32LE(position + 16);
    if (
      !(flags & 8) &&
      (bytes.readUInt32LE(offset + 14) !== crc ||
        bytes.readUInt32LE(offset + 18) !== compressedSize ||
        bytes.readUInt32LE(offset + 22) !== size)
    )
      throw unsupported();
    if (name.endsWith("/") && (size || compressedSize)) throw unsupported();
    entries.push({
      path: name,
      size,
      compressedSize,
      directory: name.endsWith("/"),
      offset: data,
      method,
      crc,
    });
    position = next;
  }
  if (position !== end) throw unsupported();
  return entries;
}

function unpack(bytes: Buffer, entry: Entry) {
  let content: Buffer;
  try {
    const compressed = bytes.subarray(entry.offset, entry.offset + entry.compressedSize);
    content =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: ZIP_LIMITS.entry });
  } catch {
    throw unsupported();
  }
  if (content.length !== entry.size || crc32(content) !== entry.crc) throw unsupported();
  return content;
}
export function listZipEntries(input: Uint8Array) {
  const bytes = Buffer.from(input);
  const entries = parse(bytes);
  // Validate CRC and actual sizes as well as headers; total decompression is bounded by ZIP_LIMITS.total.
  let total = 0;
  for (const entry of entries) {
    total += unpack(bytes, entry).length;
    if (total > ZIP_LIMITS.total) throw unsupported();
  }
  return entries.map(({ path, size, compressedSize, directory }) => ({
    path,
    size,
    compressedSize,
    directory,
  }));
}
export function readZipText(input: Uint8Array, entryPath: string) {
  const bytes = Buffer.from(input);
  const entry = parse(bytes).find((x) => x.path === entryPath);
  if (!entry || entry.directory)
    throw new ORPCError("NOT_FOUND", { message: "ZIP entry not found." });
  const content = unpack(bytes, entry);
  if (content.includes(0)) throw unsupported();
  try {
    return {
      path: entry.path,
      text: new TextDecoder("utf-8", { fatal: true }).decode(content),
      size: content.length,
    };
  } catch {
    throw unsupported();
  }
}
export async function loadZipArtifact(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  actor: Actor,
  artifactId: string,
) {
  const row = await deps.prisma.artifact.findFirst({
    where: { id: artifactId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (row?.mimeType !== "application/zip") throw new IsolationError();
  if (row.size > ZIP_LIMITS.archive) throw unsupported();
  return deps.artifacts.get(row.storageKey, {
    operationId: `artifact-zip:${row.id}`,
    traceId: `artifact-zip:${row.id}`,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: row.botId ?? row.groupId ?? row.id,
    signal: new AbortController().signal,
  });
}
