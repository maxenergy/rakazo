import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const RunDiagnosticSectionSchema = z.enum(["attempts", "events", "effects", "usage"]);
export const RunDiagnosticsInputSchema = z.object({
  runId: Id,
  section: RunDiagnosticSectionSchema,
  limit: z.number().int().min(1).max(100).default(25),
  before: z.object({ at: IsoDate, id: Id }).optional(),
});
export type RunDiagnosticsInput = z.infer<typeof RunDiagnosticsInputSchema>;

// Only explicitly selected metadata belongs here. Never expose checkpoint, error,
// request/result, event payload, lease owner, or arbitrary provider text.
export const RunDiagnosticEntrySchema = z.object({
  id: Id,
  at: IsoDate,
  kind: z.string(),
  status: z.string().nullable(),
  fence: z.number().int().nullable(),
  finishedAt: IsoDate.nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  callId: Id.nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  costMicroUsd: z.string().regex(/^-?\d+$/).nullable(),
  evidence: z.object({ runId: Id, threadId: Id, eventSeq: z.number().int().nullable() }),
});
export const RunDiagnosticsOutputSchema = z.object({
  runId: Id,
  status: z.string(),
  section: RunDiagnosticSectionSchema,
  entries: z.array(RunDiagnosticEntrySchema).max(100),
  nextCursor: z.object({ at: IsoDate, id: Id }).nullable(),
  windowStartedAt: IsoDate,
  historyMayBeIncomplete: z.literal(true),
});
export type RunDiagnosticsOutput = z.infer<typeof RunDiagnosticsOutputSchema>;
