import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface PiSegment {
  messages: AgentMessage[];
  toolCallSeq: number;
  seenSteeringIds: string[];
}

export function encodePiSegment(segment: PiSegment): string {
  return JSON.stringify({ version: 1, ...segment });
}

export function decodePiSegment(value: string | undefined): PiSegment | undefined {
  if (value === undefined) return undefined;
  const segment = JSON.parse(value);
  if (
    segment.version !== 1 ||
    !Array.isArray(segment.messages) ||
    !segment.messages.every(
      (message: AgentMessage) =>
        message && ["system", "user", "assistant", "toolResult"].includes(message.role),
    ) ||
    !Number.isSafeInteger(segment.toolCallSeq) ||
    segment.toolCallSeq < 0 ||
    !Array.isArray(segment.seenSteeringIds) ||
    !segment.seenSteeringIds.every((id: unknown) => typeof id === "string")
  ) {
    throw new Error("Invalid run segment checkpoint");
  }
  return segment;
}
