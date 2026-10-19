import { createHash, randomUUID } from "node:crypto";

/** Process-local availability hints; never an authorization or budget decision. */
export class ModelCooldown {
  private readonly salt = randomUUID();
  private readonly deadlines = new Map<string, number>();

  key(spaceId: string | undefined, userId: string | undefined, provider: string, modelId: string, credential: string | undefined): string {
    return createHash("sha256").update(this.salt).update(JSON.stringify([spaceId, userId, provider, modelId, credential])).digest("hex");
  }

  active(key: string, now = Date.now()): boolean {
    const deadline = this.deadlines.get(key);
    if (deadline === undefined) return false;
    if (deadline > now) return true;
    this.deadlines.delete(key);
    return false;
  }

  record(key: string, durationMs: number, now = Date.now()): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    for (const [entry, deadline] of this.deadlines) {
      if (deadline <= now) this.deadlines.delete(entry);
    }
    if (!this.deadlines.has(key) && this.deadlines.size >= 4096) {
      const oldest = this.deadlines.keys().next().value;
      if (oldest !== undefined) this.deadlines.delete(oldest);
    }
    this.deadlines.set(key, Math.max(this.deadlines.get(key) ?? 0, now + Math.min(durationMs, 86_400_000)));
  }
}
