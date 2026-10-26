import {
  CreateGoalInput,
  CreateKeyResultInput,
  EditProjectMemberInput,
  ListGoalsInput,
  ListKeyResultsInput,
  ProjectMembersInput,
  SetProjectOwnerInput,
  UpdateGoalInput,
  UpdateKeyResultInput,
  UpdateProjectInput,
} from "@rakazo/contracts";
import {
  archiveKeyResult,
  assertExecutionFence,
  createGoal,
  createKeyResult,
  deleteGoal,
  deleteKeyResult,
  type ExecutionFence,
  editProjectMember,
  lockTicketSpace,
  Prisma,
  type PrismaClient,
  ProjectLinkError,
  readGoals,
  readKeyResults,
  readProjectMembers,
  readProjects,
  updateGoal,
  updateKeyResult,
  updateProject,
  withTransactionRetry,
} from "@rakazo/db";
import { z } from "zod";

const idInput = z.object({ id: z.string().min(1) });
export const goalToolInputs = {
  project_update: UpdateProjectInput,
  project_members: ProjectMembersInput,
  project_add_member: EditProjectMemberInput,
  project_remove_member: EditProjectMemberInput,
  project_set_owner: SetProjectOwnerInput,
  goal_list: ListGoalsInput,
  goal_get: idInput,
  goal_create: CreateGoalInput,
  goal_update: UpdateGoalInput,
  goal_delete: idInput,
  key_result_list: ListKeyResultsInput,
  key_result_get: idInput,
  key_result_create: CreateKeyResultInput,
  key_result_update: UpdateKeyResultInput,
  key_result_archive: idInput,
  key_result_delete: idInput,
};
export type GoalToolName = keyof typeof goalToolInputs;
export function isGoalToolName(name: string): name is GoalToolName {
  return Object.hasOwn(goalToolInputs, name);
}

export async function executeGoalTool(
  deps: { prisma: PrismaClient; ticketBoardEnabled?: boolean; executionFence?: ExecutionFence },
  spaceId: string,
  name: GoalToolName,
  args: unknown,
) {
  if (!deps.ticketBoardEnabled) return { error: "Ticket board is disabled." };
  const parsed = goalToolInputs[name].safeParse(args);
  if (!parsed.success) return { error: parsed.error.message };
  try {
    return await withTransactionRetry(() =>
      deps.prisma.$transaction(
        async (tx) => {
          if (deps.executionFence) {
            await lockTicketSpace(tx, spaceId);
            await assertExecutionFence(tx, deps.executionFence);
          }
          switch (name) {
            case "project_update": {
              const row = await updateProject(tx, spaceId, UpdateProjectInput.parse(args));
              return {
                ...(await readProjects(tx, spaceId, { id: row.id }))[0]!,
                cancellationRequests: (UpdateProjectInput.parse(args).cancelRunIds ?? []).map(
                  (id) => ({ id, externalProcessState: "needs_confirmation" as const }),
                ),
              };
            }
            case "project_members":
              return readProjectMembers(tx, spaceId, ProjectMembersInput.parse(args).projectId);
            case "project_add_member":
              return editProjectMember(tx, spaceId, "add", EditProjectMemberInput.parse(args));
            case "project_remove_member":
              return editProjectMember(tx, spaceId, "remove", EditProjectMemberInput.parse(args));
            case "project_set_owner":
              return editProjectMember(tx, spaceId, "owner", SetProjectOwnerInput.parse(args));
            case "goal_list":
              return readGoals(tx, spaceId, ListGoalsInput.parse(args));
            case "goal_get":
              return (await readGoals(tx, spaceId, idInput.parse(args)))[0]!;
            case "goal_create": {
              const row = await createGoal(tx, spaceId, CreateGoalInput.parse(args));
              return (await readGoals(tx, spaceId, { id: row.id }))[0]!;
            }
            case "goal_update": {
              const row = await updateGoal(tx, spaceId, UpdateGoalInput.parse(args));
              return (await readGoals(tx, spaceId, { id: row.id }))[0]!;
            }
            case "goal_delete":
              await deleteGoal(tx, spaceId, idInput.parse(args).id);
              return { ok: true };
            case "key_result_list":
              return readKeyResults(tx, spaceId, ListKeyResultsInput.parse(args));
            case "key_result_get":
              return (await readKeyResults(tx, spaceId, idInput.parse(args)))[0]!;
            case "key_result_create": {
              const row = await createKeyResult(tx, spaceId, CreateKeyResultInput.parse(args));
              return (await readKeyResults(tx, spaceId, { id: row.id }))[0]!;
            }
            case "key_result_update": {
              const row = await updateKeyResult(tx, spaceId, UpdateKeyResultInput.parse(args));
              return (await readKeyResults(tx, spaceId, { id: row.id }))[0]!;
            }
            case "key_result_archive": {
              const { id } = idInput.parse(args);
              await archiveKeyResult(tx, spaceId, id);
              return (await readKeyResults(tx, spaceId, { id }))[0]!;
            }
            case "key_result_delete":
              await deleteKeyResult(tx, spaceId, idInput.parse(args).id);
              return { ok: true };
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    );
  } catch (error) {
    if (error instanceof ProjectLinkError) return { error: error.message };
    throw error;
  }
}
