import { z } from "zod";

export const ModelCapabilityEvidenceSchema = z.object({
  value: z.boolean().nullable(),
  source: z.string().min(1).nullable(),
});
export const ModelCapabilitiesSchema = z.object({
  imageInput: ModelCapabilityEvidenceSchema,
  reasoning: ModelCapabilityEvidenceSchema,
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
export type ModelCapability = keyof ModelCapabilities;
