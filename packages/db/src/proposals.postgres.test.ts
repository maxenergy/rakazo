import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { assertProposalApproval, decideProposal, proposalContentHash } from "./proposals.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
(enabled ? describe.sequential : describe.skip)("Proposal versions", () => {
  const db = createDb(process.env.DATABASE_URL!);
  const id = `proposal-version-${process.pid}-${Date.now()}`;
  let botId: string;
  beforeAll(async () => {
    await db.prisma.user.create({ data: { id, email: `${id}@example.test`, name: "Fixture" } });
    await db.prisma.organization.create({
      data: { id, name: "Fixture", slug: id, createdAt: new Date() },
    });
    await db.prisma.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    botId = (
      await db.prisma.bot.create({
        data: { userId: id, spaceId: id, name: "Fixture", color: "blue" },
      })
    ).id;
  });
  afterAll(async () => {
    try {
      await db.prisma.organization.deleteMany({ where: { id } });
      await db.prisma.user.deleteMany({ where: { id } });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  it("matches application hashes for null, empty and populated options", async () => {
    const content = {
      kind: "plan",
      title: '中文 "quoted"\\\n',
      summary: "Résumé 😀",
      options: [] as string[],
      recommendation: "A",
    };
    for (const options of [null, [], ["A", "B"]]) {
      const input = { ...content, options };
      const result = await db.pool.query<{ hash: string }>(
        "SELECT proposal_content_hash($1::text,$2::text,$3::text,$4::text[],$5::text) AS hash",
        [input.kind, input.title, input.summary, input.options, input.recommendation],
      );
      expect(result.rows[0]?.hash).toBe(
        proposalContentHash(input as unknown as Parameters<typeof proposalContentHash>[0]),
      );
    }
    const input = { ...content, recommendation: null };
    const result = await db.pool.query<{ hash: string }>(
      "SELECT proposal_content_hash($1::text,$2::text,$3::text,$4::text[],$5::text) AS hash",
      [input.kind, input.title, input.summary, input.options, input.recommendation],
    );
    expect(result.rows[0]?.hash).toBe(
      proposalContentHash(input as unknown as Parameters<typeof proposalContentHash>[0]),
    );
  });
  it("versions content edits and rejects the previous approval", async () => {
    const original = await db.prisma.proposal.create({
      data: {
        userId: id,
        spaceId: id,
        botId,
        submitKey: id,
        kind: "plan",
        title: '中文 "quoted"\\\n',
        summary: "Résumé 😀",
        options: ["A", "B"],
        recommendation: "A",
      },
    });
    expect(original.version).toBe(1);
    expect(original.contentHash).toBe(proposalContentHash(original));
    await decideProposal(
      db.prisma,
      { userId: id, spaceId: id },
      {
        proposalId: original.id,
        decision: "approve",
        expectedVersion: 1,
        expectedHash: original.contentHash,
      },
    );
    const approved = await db.prisma.proposal.findUniqueOrThrow({ where: { id: original.id } });
    expect(() => assertProposalApproval(approved)).not.toThrow();
    const edited = await db.prisma.proposal.update({
      where: { id: original.id },
      data: { summary: "Changed" },
    });
    expect(edited.version).toBe(2);
    expect(edited.contentHash).toBe(proposalContentHash(edited));
    expect(edited.status).toBe("pending");
    expect(edited.approvedVersion).toBe(1);
    expect(() => assertProposalApproval(edited)).toThrow();
    await expect(
      decideProposal(
        db.prisma,
        { userId: id, spaceId: id },
        {
          proposalId: original.id,
          decision: "approve",
          expectedVersion: 1,
          expectedHash: original.contentHash,
        },
      ),
    ).rejects.toThrow("content changed");
    const unchanged = await db.prisma.proposal.update({
      where: { id: original.id },
      data: { summary: "Changed" },
    });
    expect(unchanged.version).toBe(2);
  });
});
