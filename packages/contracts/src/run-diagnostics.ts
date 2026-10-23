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
  costMicroUsd: z
    .string()
    .regex(/^-?\d+$/)
    .nullable(),
  derived: z.enum(["model_changed", "lease_takeover"]).nullable().optional(),
  steering: z
    .object({
      messageId: Id,
      receivedAt: IsoDate,
      deliveredAt: IsoDate,
      usage: z.object({ runId: Id, section: z.literal("usage"), attribution: z.literal("run") }),
    })
    .optional(),
  recovery: z
    .object({
      match: z.enum(["matched", "unmatched"]),
      legacy: z.boolean(),
      effect: z
        .object({
          id: Id,
          kind: z.string(),
          status: z.string(),
          reviewDecision: z.string().nullable(),
          createdAt: IsoDate,
        })
        .nullable(),
    })
    .optional(),
  evidence: z.object({
    runId: Id,
    threadId: Id,
    eventSeq: z.number().int().nullable(),
    sourceHref: z.string().nullable().optional(),
  }),
});
export const RunDiagnosticsOutputSchema = z.object({
  runId: Id,
  runContext: z
    .object({
      modelProvider: z.string().nullable(),
      modelId: z.string().nullable(),
      modelPinned: z.boolean(),
      leaseFence: z.number().int(),
    })
    .optional(),
  status: z.string(),
  section: RunDiagnosticSectionSchema,
  entries: z.array(RunDiagnosticEntrySchema).max(100),
  nextCursor: z.object({ at: IsoDate, id: Id }).nullable(),
  windowStartedAt: IsoDate,
  historyMayBeIncomplete: z.literal(true),
});
export type RunDiagnosticsOutput = z.infer<typeof RunDiagnosticsOutputSchema>;
