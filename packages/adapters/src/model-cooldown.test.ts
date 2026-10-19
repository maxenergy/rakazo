import { describe, expect, it } from "vitest";
import { ModelCooldown } from "./model-cooldown.js";

describe("ModelCooldown", () => {
  it("expires at the deadline and never shortens an existing cooldown", () => {
    const cooldown = new ModelCooldown();
    const key = cooldown.key("space", "user", "provider", "model", "fake-key");
    cooldown.record(key, 30_000, 1_000);
    cooldown.record(key, 100, 2_000);
    expect(cooldown.active(key, 30_000)).toBe(true);
    expect(cooldown.active(key, 30_999)).toBe(true);
    expect(cooldown.active(key, 31_000)).toBe(false);
    expect(cooldown.active(key, 32_000)).toBe(false);
  });

  it("isolates users, spaces, credentials and models", () => {
    const cooldown = new ModelCooldown();
    const key = cooldown.key("space", "user", "provider", "model", "fake-key");
    cooldown.record(key, 30_000, 0);
    expect(cooldown.active(key, 1)).toBe(true);
    for (const other of [
      cooldown.key("other-space", "user", "provider", "model", "fake-key"),
      cooldown.key("space", "other-user", "provider", "model", "fake-key"),
      cooldown.key("space", "user", "provider", "model", "other-fake-key"),
      cooldown.key("space", "user", "provider", "other-model", "fake-key"),
    ])
      expect(cooldown.active(other, 1)).toBe(false);
    expect(key).not.toContain("fake-key");
  });
});
