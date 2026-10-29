import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTransactionRetry } from "./transaction-retry.js";

function conflict(code: string) {
  return Object.assign(new Error("transaction conflict"), {
    code: code === "P2034" ? code : "P2039",
    ...(code === "P2034"
      ? {}
      : { meta: { driverAdapterError: { cause: { originalCode: code } } } }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("withTransactionRetry", () => {
  it.each(["P2034", "40001", "40P01"])(
    "backs off before retrying %s successfully",
    async (code) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const sleep = vi.fn(async (_milliseconds: number) => {});
      const operation = vi.fn<() => Promise<string>>().mockImplementation(async () => {
        if (operation.mock.calls.length < 5) throw conflict(code);
        return "ok";
      });

      await expect(withTransactionRetry(operation, sleep)).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(5);
      expect(sleep.mock.calls).toEqual([[10], [20], [30], [40]]);
      for (let index = 0; index < 4; index += 1) {
        expect(operation.mock.invocationCallOrder[index]).toBeLessThan(
          sleep.mock.invocationCallOrder[index]!,
        );
        expect(sleep.mock.invocationCallOrder[index]).toBeLessThan(
          operation.mock.invocationCallOrder[index + 1]!,
        );
      }
    },
  );

  it("immediately rethrows non-retryable errors", async () => {
    const error = conflict("23505");
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});

    await expect(withTransactionRetry(operation, sleep)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["P2034", "40001", "40P01"])(
    "warns and rethrows the original final %s error after five attempts",
    async (code) => {
      vi.spyOn(Math, "random").mockReturnValue(0.999999);
      const error = conflict(code);
      const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);
      const sleep = vi.fn(async (_milliseconds: number) => {});
      const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});

      await expect(withTransactionRetry(operation, sleep)).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(5);
      expect(sleep.mock.calls).toEqual([[50], [100], [150], [200]]);
      expect(warn).toHaveBeenCalledExactlyOnceWith("Transaction conflict retries exhausted", {
        attempts: 5,
        code: error.code,
        databaseCode: code === "P2034" ? undefined : code,
      });
    },
  );
});
