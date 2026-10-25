import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./index.js";
import { editProjectMember, readBotProjects, readProjectMembers } from "./project-members.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
(enabled ? describe.sequential : describe.skip)("Project members", () => {
  const db = createDb(process.env.DATABASE_URL!);
  const prisma = db.prisma;
  const id = `members-${process.pid}-${Date.now()}`;
  const foreign = `${id}-foreign`;
  let projectId: string;
  let secondProjectId: string;
  let botId: string;
  let secondBotId: string;
  let foreignBotId: string;
  beforeAll(async () => {
    await prisma.user.create({ data: { id, email: `${id}@example.test`, name: "Fixture" } });
    await prisma.organization.create({
      data: { id, name: "Fixtures", slug: id, createdAt: new Date() },
    });
    await prisma.space.createMany({
      data: [
        { id, organizationId: id, name: "Local" },
        { id: foreign, organizationId: id, name: "Foreign" },
      ],
    });
    projectId = (await prisma.project.create({ data: { spaceId: id, name: "One" } })).id;
    secondProjectId = (await prisma.project.create({ data: { spaceId: id, name: "Two" } })).id;
    botId = (
      await prisma.bot.create({ data: { spaceId: id, userId: id, name: "CEO", color: "blue" } })
    ).id;
    secondBotId = (
      await prisma.bot.create({ data: { spaceId: id, userId: id, name: "CTO", color: "blue" } })
    ).id;
    foreignBotId = (
      await prisma.bot.create({
        data: { spaceId: foreign, userId: id, name: "Other", color: "blue" },
      })
    ).id;
  });
  afterAll(async () => {
    try {
      await prisma.organization.deleteMany({ where: { id } });
      await prisma.user.deleteMany({ where: { id } });
    } finally {
      await prisma.$disconnect();
      await db.pool.end();
    }
  });
  const edit = (action: "add" | "remove" | "owner", bot: string | null, project = projectId) =>
    prisma.$transaction((tx) =>
      editProjectMember(tx, id, action, { projectId: project, botId: bot }),
    );
  it("preserves owner uniqueness, idempotence and membership across projects", async () => {
    await edit("owner", botId);
    expect((await edit("add", botId)).map((row) => row.role)).toEqual(["owner"]);
    await edit("add", secondBotId);
    await edit("owner", secondBotId);
    const members = await prisma.$transaction((tx) => readProjectMembers(tx, id, projectId));
    expect(members.find((row) => row.botId === botId)?.role).toBe("member");
    expect(members.filter((row) => row.role === "owner")).toHaveLength(1);
    await edit("owner", botId, secondProjectId);
    await edit("add", secondBotId, secondProjectId);
    expect(await prisma.$transaction((tx) => readBotProjects(tx, id, botId))).toHaveLength(2);
    await edit("owner", null);
    expect((await edit("add", botId)).every((row) => row.role === "member")).toBe(true);
    await edit("owner", botId);
    expect((await edit("remove", botId)).some((row) => row.role === "owner")).toBe(false);
  });
  it("rejects cross-space projects and bots without modifying membership", async () => {
    await expect(edit("add", foreignBotId)).rejects.toThrow("Resource not found.");
    await expect(
      prisma.$transaction((tx) => readProjectMembers(tx, foreign, projectId)),
    ).rejects.toThrow("Resource not found.");
    await expect(
      prisma.$transaction((tx) =>
        editProjectMember(tx, foreign, "owner", { projectId, botId: foreignBotId }),
      ),
    ).rejects.toThrow("Resource not found.");
    expect(await prisma.projectMember.count({ where: { botId: foreignBotId } })).toBe(0);
  });
  it("defaults existing-style project inserts to active with no pause", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("active");
    expect(project.pausedAt).toBeNull();
  });
});
