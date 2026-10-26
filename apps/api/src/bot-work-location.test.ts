import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { requireHostOwnerSession } from "./bot-work-location.js";

const owner: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
function fixture() {
  const prisma = {
    session: { findFirst: vi.fn().mockResolvedValue({ id: "human-session" }) },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: "owner" }) },
  };
  return { prisma, db: prisma as unknown as PrismaClient };
}
describe("host work location authorization", () => {
  it("rejects bot runs inheriting the deployment owner actor without a human session", async () => {
    const { db, prisma } = fixture();
    await expect(requireHostOwnerSession(db, owner, undefined)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
  });
  it("requires a live session for the actual deployment owner", async () => {
    const { db, prisma } = fixture();
    await expect(requireHostOwnerSession(db, owner, "human-session")).resolves.toBeUndefined();
    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: { id: "human-session", userId: "owner", expiresAt: { gt: expect.any(Date) } },
      select: { id: true },
    });
    prisma.session.findFirst.mockResolvedValue(null as never);
    await expect(requireHostOwnerSession(db, owner, "expired")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("rejects nonowners and stale owner claims", async () => {
    const { db, prisma } = fixture();
    await expect(
      requireHostOwnerSession(db, { ...owner, isDeploymentOwner: false }, "session"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    prisma.deploymentSettings.findUnique.mockResolvedValue({ ownerUserId: "different-owner" });
    await expect(requireHostOwnerSession(db, owner, "session")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
