import {
  CreateGoalInput,
  CreateKeyResultInput,
  ListGoalsInput,
  ListKeyResultsInput,
  UpdateGoalInput,
  UpdateKeyResultInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  archiveKeyResult,
  createGoal,
  createKeyResult,
  deleteGoal,
  deleteKeyResult,
  Prisma,
  ProjectLinkError,
  readGoals,
  readKeyResults,
  updateGoal,
  updateKeyResult,
  withTransactionRetry,
} from "@rakazo/db";
import { z } from "zod";

const idInput = z.object({ id: z.string().min(1) });
export const goalToolInputs = {
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
  deps: { prisma: PrismaClient; ticketBoardEnabled?: boolean },
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
          switch (name) {
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
