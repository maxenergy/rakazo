import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

const name = z.string().trim().min(1).max(200);
const description = z.string().max(20_000);
export const ProjectProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  ratio: z.number().min(0).max(1).nullable(),
});
const ProjectBaseSchema = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  description: z.string().nullable(),
  archivedAt: IsoDate.nullable(),
  archived: z.boolean(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  progress: ProjectProgressSchema,
});
export const ProjectMemberSchema = z.object({
  projectId: Id,
  botId: Id,
  role: z.enum(["owner", "member"]),
  createdAt: IsoDate,
});
export const ProjectStatusSchema = z.enum(["active", "paused"]);
export const ProjectSchema = ProjectBaseSchema.extend({
  cancellationRequests: z
    .array(z.object({ id: Id, externalProcessState: z.literal("needs_confirmation") }))
    .optional(),
  inFlightRuns: z
    .array(
      z.object({
        id: Id,
        botId: Id,
        threadId: Id,
        status: z.string(),
        externalProcessState: z.literal("needs_confirmation"),
      }),
    )
    .optional(),
  status: ProjectStatusSchema,
  pausedAt: IsoDate.nullable(),
  owner: ProjectMemberSchema.nullable(),
});
export const BotProjectSchema = z.object({
  projectId: Id,
  name: z.string(),
  role: z.enum(["owner", "member"]),
  status: ProjectStatusSchema,
});
export const ProjectMembersInput = z.object({ projectId: Id });
export const EditProjectMemberInput = ProjectMembersInput.extend({ botId: Id });
export const SetProjectOwnerInput = ProjectMembersInput.extend({ botId: Id.nullable() });
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;
export const MilestoneSchema = ProjectBaseSchema.extend({
  projectId: Id,
  dueAt: IsoDate.nullable(),
});
export const CreateProjectInput = z.object({ name, description: description.optional() });
export const UpdateProjectInput = z.object({
  status: ProjectStatusSchema.optional(),
  cancelRunIds: z.array(Id).max(100).optional(),
  id: Id,
  name: name.optional(),
  description: description.nullable().optional(),
});
export const ListProjectsInput = z.object({
  archived: z.boolean().default(false),
  q: z.string().trim().max(200).optional(),
});
export const CreateMilestoneInput = CreateProjectInput.extend({
  projectId: Id,
  dueAt: IsoDate.nullable().optional(),
});
export const UpdateMilestoneInput = UpdateProjectInput.omit({
  status: true,
  cancelRunIds: true,
}).extend({
  dueAt: IsoDate.nullable().optional(),
});
export const ListMilestonesInput = ListProjectsInput.extend({ projectId: Id });
export type Project = z.infer<typeof ProjectSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type ProjectProgress = z.infer<typeof ProjectProgressSchema>;

// Decimal strings preserve exact PostgreSQL bigint amounts across JSON.
const microUsd = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]*)$/.test(value) &&
      value.length <= 19 &&
      BigInt(value) <= 9223372036854775807n,
    "Amount exceeds the supported range",
  );
export const ProjectBudgetSchema = z.object({
  projectId: Id,
  version: z.number().int().positive(),
  limitMicroUsd: microUsd,
  reservedMicroUsd: microUsd,
  settledMicroUsd: microUsd,
});
export const SetProjectBudgetInput = z.object({
  projectId: Id,
  limitMicroUsd: microUsd,
});
