import { deflateRawSync } from "node:zlib";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listZipEntries, loadZipArtifact, readZipText, ZIP_LIMITS } from "./artifact-zip.js";

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(
  items: {
    name: string;
    text?: string;
    flags?: number;
    mode?: number;
    size?: number;
    deflate?: boolean;
  }[],
) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name);
    const content = Buffer.from(item.text ?? "");
    const data = item.deflate ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(item.flags ?? 0x800, 6);
    local.writeUInt16LE(item.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(item.size ?? content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    local.copy(central, 6, 4, 26);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((item.mode ?? 0x81a4) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
describe("ZIP artifact preview", () => {
  it("lists entries and reads stored or deflated UTF8 text", () => {
    const bytes = zip([
      { name: "src/a.txt", text: "你好", deflate: true },
      { name: "b.txt", text: "hello" },
    ]);
    expect(listZipEntries(bytes).map((x) => x.path)).toEqual(["src/a.txt", "b.txt"]);
    expect(readZipText(bytes, "src/a.txt").text).toBe("你好");
    expect(readZipText(bytes, "b.txt").text).toBe("hello");
    expect(() => readZipText(bytes, "missing")).toThrow("ZIP entry not found");
  });
  it("rejects traversal, absolute paths and symlinks", () => {
    for (const name of ["../a", "/a", "C:/a", "a/../../b", "a\\b", "a:stream"]) {
      expect(() => listZipEntries(zip([{ name }]))).toThrow("Unsupported");
    }
    expect(() => listZipEntries(zip([{ name: "link", mode: 0xa1ff }]))).toThrow("Unsupported");
  });
  it("rejects corrupt, encrypted and unsupported archives", () => {
    expect(() => listZipEntries(Buffer.from("broken"))).toThrow("Unsupported");
    expect(() => listZipEntries(zip([{ name: "a", flags: 0x801 }]))).toThrow("Unsupported");
    const bytes = zip([{ name: "a", text: "hello" }]);
    bytes[31] = 0;
    expect(() => readZipText(bytes, "a")).toThrow("Unsupported");
    expect(() => listZipEntries(bytes)).toThrow("Unsupported");
    expect(() => listZipEntries(bytes.subarray(0, bytes.length - 1))).toThrow("Unsupported");
  });
  it("enforces archive, entry count and declared decompressed size limits", () => {
    expect(() => listZipEntries(Buffer.alloc(ZIP_LIMITS.archive + 1))).toThrow("Unsupported");
    expect(() =>
      listZipEntries(
        zip(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: String(i) }))),
      ),
    ).toThrow("Unsupported");
    expect(() => listZipEntries(zip([{ name: "a", size: ZIP_LIMITS.entry + 1 }]))).toThrow(
      "Unsupported",
    );
    expect(() =>
      listZipEntries(
        zip(Array.from({ length: 9 }, (_, i) => ({ name: String(i), size: ZIP_LIMITS.entry }))),
      ),
    ).toThrow("Unsupported");
  });
  it("bounds actual inflation and validates CRC, size and text", () => {
    const bomb = zip([
      { name: "a", text: "A".repeat(ZIP_LIMITS.entry + 1), size: 1, deflate: true },
    ]);
    expect(() => readZipText(bomb, "a")).toThrow("Unsupported");
    expect(() => readZipText(zip([{ name: "a", text: "\0" }]), "a")).toThrow("Unsupported");
  });
  it("authorizes by space and user before loading bytes", async () => {
    const get = vi.fn();
    const findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      loadZipArtifact(
        {
          prisma: { artifact: { findFirst } } as unknown as PrismaClient,
          artifacts: { get } as unknown as ArtifactStore,
        },
        { spaceId: "space", userId: "user" },
        "artifact",
      ),
    ).rejects.toThrow();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "artifact", spaceId: "space", userId: "user" },
    });
    expect(get).not.toHaveBeenCalled();
  });
});
