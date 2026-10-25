import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { updateProject } from "./project-writes.js";

function fixture() {
  const update = vi.fn(async ({ data }) => ({ id: "project", ...data }));
  const runUpdate = vi.fn();
  const taskUpdate = vi.fn();
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ id: "project", archivedAt: null }]),
    project: { update },
    run: { findMany: vi.fn(async () => [{ id: "run", taskId: "task" }]), updateMany: runUpdate },
    attempt: { updateMany: vi.fn() },
    task: { updateMany: taskUpdate },
    cloudAgent: { updateMany: vi.fn() },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, update, runUpdate, taskUpdate };
}

describe("项目暂停和恢复写入", () => {
  it("仅更新项目状态和暂停时间，默认让在途运行收尾", async () => {
    const f = fixture();
    await updateProject(f.tx, "space", { id: "project", status: "paused" });
    expect(f.update).toHaveBeenLastCalledWith({
      where: { id: "project" },
      data: { status: "paused", pausedAt: expect.any(Date) },
    });
    expect(f.runUpdate).not.toHaveBeenCalled();
    expect(f.taskUpdate).not.toHaveBeenCalled();
    await updateProject(f.tx, "space", { id: "project", status: "active" });
    expect(f.update).toHaveBeenLastCalledWith({
      where: { id: "project" },
      data: { status: "active", pausedAt: null },
    });
  });

  it("只取消明确选择且属于当前项目的运行，并请求外部任务取消", async () => {
    const f = fixture();
    await updateProject(f.tx, "space", { id: "project", cancelRunIds: ["run"] });
    expect(f.raw.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space",
          projectId: "project",
          id: { in: ["run"] },
        }),
      }),
    );
    expect(f.runUpdate).toHaveBeenCalled();
    expect(f.raw.cloudAgent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cancelRequested: true }) }),
    );
  });

  it("拒绝不属于项目的取消请求", async () => {
    const f = fixture();
    f.raw.run.findMany.mockResolvedValue([]);
    await expect(
      updateProject(f.tx, "space", { id: "project", cancelRunIds: ["foreign"] }),
    ).rejects.toThrow("Only active runs belonging");
    expect(f.runUpdate).not.toHaveBeenCalled();
  });
});
