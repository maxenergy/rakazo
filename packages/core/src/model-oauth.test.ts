import { describe, expect, it, vi } from "vitest";
import { modelOAuthErrorMessage, waitForModelOAuthCompletion } from "./model-oauth.js";

describe("modelOAuthErrorMessage", () => {
  it("uses translated catalog keys for failed, expired, and rejected CLI sign-ins", () => {
    expect(modelOAuthErrorMessage(new Error("CLI sign-in failed. Start sign-in again."))).toBe(
      "Could not connect this provider",
    );
    expect(modelOAuthErrorMessage(new Error("CLI request timed out. Try again."))).toBe(
      "Authorization timed out. Please try again.",
    );
    expect(
      modelOAuthErrorMessage(new Error("Sign-in session not found. Start sign-in again.")),
    ).toBe("Authorization timed out. Please try again.");
    expect(
      modelOAuthErrorMessage(new Error("Authorization code is invalid. Start sign-in again.")),
    ).toBe("Authorization code is invalid. Start sign-in again.");
  });

  it("does not expose vendor diagnostics or non-error payloads", () => {
    for (const error of [
      new Error("OAuth rejected for private@example.test; token=fake-secret"),
      { message: "private diagnostic" },
      null,
    ])
      expect(modelOAuthErrorMessage(error)).toBe("Could not connect this provider");
  });

  it.each([
    "Antigravity is not available in this account's region.",
    "This account is not eligible for Antigravity.",
  ])("preserves only the owned eligibility catalog key: %s", (message) => {
    expect(modelOAuthErrorMessage(new Error(message))).toBe(message);
    expect(modelOAuthErrorMessage(new Error(`${message} private@example.test`))).toBe(
      "Could not connect this provider",
    );
  });
});

describe("waitForModelOAuthCompletion", () => {
  it("stops polling when its signal is aborted", async () => {
    const complete = vi.fn().mockResolvedValue({ status: "pending" as const });
    const controller = new AbortController();
    const polling = waitForModelOAuthCompletion(complete, {
      signal: controller.signal,
      pollIntervalMs: 60_000,
    });

    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(polling).rejects.toBeDefined();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("returns readiness without another poll", async () => {
    const complete = vi.fn().mockResolvedValue({ status: "ready" as const });

    await expect(waitForModelOAuthCompletion(complete)).resolves.toEqual({
      status: "ready",
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("stops after the configured attempt limit", async () => {
    const complete = vi.fn().mockResolvedValue({ status: "pending" as const });

    await expect(
      waitForModelOAuthCompletion(complete, { attempts: 2, pollIntervalMs: 0 }),
    ).rejects.toThrow("timed out");
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
