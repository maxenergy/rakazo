import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const GoalStateSchema = z.enum(["planned", "active", "achieved", "cancelled"]);
const name = z.string().trim().min(1).max(200);
const description = z.string().max(20_000);
const value = z.number().finite();
const fields = {
  name,
  description: description.nullable().optional(),
  state: GoalStateSchema.optional(),
  dueAt: IsoDate.nullable().optional(),
};
export const CreateGoalInput = z.object({ ...fields, projectId: Id });
export const UpdateGoalInput = z.object({
  id: Id,
  name: name.optional(),
  description: description.nullable().optional(),
  state: GoalStateSchema.optional(),
  dueAt: IsoDate.nullable().optional(),
});
export const ListGoalsInput = z.object({ projectId: Id, archived: z.boolean().default(false) });
export const GoalSchema = z.object({
  id: Id,
  spaceId: Id,
  projectId: Id,
  name: z.string(),
  description: z.string().nullable(),
  state: GoalStateSchema,
  dueAt: IsoDate.nullable(),
  archivedAt: IsoDate.nullable(),
  archived: z.boolean(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
const measure = z.string().trim().min(1).max(200);
const calculationRule = z.string().trim().min(1).max(2_000);
export const CreateKeyResultInput = z.object({
  ...fields,
  goalId: Id,
  milestoneId: Id.nullable().optional(),
  measure,
  targetValue: value,
  currentValue: value,
  calculationRule,
});
export const UpdateKeyResultInput = z.object({
  id: Id,
  name: name.optional(),
  description: description.nullable().optional(),
  state: GoalStateSchema.optional(),
  dueAt: IsoDate.nullable().optional(),
  milestoneId: Id.nullable().optional(),
  measure: measure.optional(),
  targetValue: value.optional(),
  currentValue: value.optional(),
  calculationRule: calculationRule.optional(),
});
export const ListKeyResultsInput = z.object({ goalId: Id, archived: z.boolean().default(false) });
export const KeyResultSchema = GoalSchema.extend({
  goalId: Id,
  milestoneId: Id.nullable(),
  measure: z.string(),
  targetValue: value,
  currentValue: value,
  calculationRule: z.string(),
});
export type Goal = z.infer<typeof GoalSchema>;
export type KeyResult = z.infer<typeof KeyResultSchema>;
