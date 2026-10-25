export type ProjectPauseStatus = "active" | "paused";

export function nextProjectPauseStatus(status: ProjectPauseStatus): ProjectPauseStatus {
  return status === "paused" ? "active" : "paused";
}
