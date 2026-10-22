import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createCliDiscoveryCache, discoverSelectedCliCredential } from "./cli-model-admission.js";

const profileId = "11111111-1111-4111-8111-111111111111";
const success = {
  status: "discovered" as const,
  models: [{ id: "new", model: "fixture-new-model", displayName: "New" }],
};
function fixture() {
  const findFirst = vi.fn(async () => ({ id: "secret", ciphertext: "cipher-v1" }));
  const load = vi.fn(async () =>
    JSON.stringify({ kind: "cli", credential: { type: "cli", profileId } }),
  );
  return { prisma: { secret: { findFirst } } as unknown as PrismaClient, findFirst, load };
}
describe("CLI discovery evidence", () => {
  it("bounds the process cache at 128 entries", async () => {
    const discover = vi.fn().mockResolvedValue(success);
    const cache = createCliDiscoveryCache(discover);
    for (let index = 0; index < 129; index++) await cache(String(index), profileId);
    expect(await cache("0", profileId, true)).toEqual({ status: "static", models: null });
    expect(await cache("128", profileId, true)).toEqual(success);
  });

  it("closes expired evidence when refresh fails; an empty discovery is valid", async () => {
    let now = 0;
    const discover = vi
      .fn()
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({ status: "static", models: null })
      .mockResolvedValueOnce({ status: "discovered", models: [] });
    const cache = createCliDiscoveryCache(discover, () => now);
    expect(await cache("scope", profileId)).toEqual(success);
    now = 60_000;
    expect(await cache("scope", profileId, true)).toEqual({ status: "static", models: null });
    expect(await cache("scope", profileId)).toEqual({ status: "static", models: null });
    now += 5_000;
    expect(await cache("scope", profileId)).toEqual({ status: "discovered", models: [] });
    expect(discover).toHaveBeenCalledWith(profileId, 5_000);
  });

  it("isolates users, spaces, credentials, secret revisions and profiles", async () => {
    const f = fixture();
    const discover = vi.fn().mockResolvedValue(success);
    const cache = createCliDiscoveryCache(discover);
    const scope = { userId: "user-a", spaceId: "space-a" };
    const credential = { id: "credential-a", secretId: "secret" };
    const read = (s = scope, c = credential, cacheOnly = false) =>
      discoverSelectedCliCredential(f.prisma, { load: f.load }, s, c, cacheOnly, cache);
    expect(await read()).toEqual(success);
    expect(await read({ ...scope, userId: "user-b" }, credential, true)).toEqual({
      status: "static",
      models: null,
    });
    expect(await read({ ...scope, spaceId: "space-b" }, credential, true)).toEqual({
      status: "static",
      models: null,
    });
    expect(await read(scope, { ...credential, id: "credential-b" }, true)).toEqual({
      status: "static",
      models: null,
    });
    f.findFirst.mockResolvedValue({ id: "secret", ciphertext: "cipher-v2" });
    expect(await read(scope, credential, true)).toEqual({ status: "static", models: null });
    f.findFirst.mockResolvedValue({ id: "secret", ciphertext: "cipher-v1" });
    f.load.mockResolvedValue(
      JSON.stringify({
        kind: "cli",
        credential: { type: "cli", profileId: "22222222-2222-4222-8222-222222222222" },
      }),
    );
    expect(await read(scope, credential, true)).toEqual({ status: "static", models: null });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { id: "secret", userId: "user-a", spaceId: null },
      select: { id: true, ciphertext: true },
    });
  });

  it("never reuses cached evidence when the selected secret cannot be read", async () => {
    const f = fixture();
    const discover = vi.fn().mockResolvedValue(success);
    const cache = createCliDiscoveryCache(discover);
    const read = () =>
      discoverSelectedCliCredential(
        f.prisma,
        { load: f.load },
        { userId: "user", spaceId: "space" },
        { id: "credential", secretId: "secret" },
        false,
        cache,
      );
    expect(await read()).toEqual(success);
    f.load.mockRejectedValue(new Error("unreadable"));
    expect(await read()).toEqual({ status: "static", models: null });
    expect(discover).toHaveBeenCalledTimes(1);
  });
});
