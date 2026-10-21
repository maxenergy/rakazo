// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ bootstrap: vi.fn() }));
vi.mock("./rpc", () => ({ rpc: { bootstrap: mocks.bootstrap } }));
vi.mock("./performance", () => ({ markOnce: vi.fn() }));
vi.mock("./bootstrap-target", () => ({ initialBootstrapTarget: () => null }));
beforeEach(() => {
  vi.resetModules();
  mocks.bootstrap.mockReset();
});
it.each([true, false])("publishes capability after bootstrap: %s", async (enabled) => {
  let resolve!: (value: unknown) => void;
  mocks.bootstrap.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const module = await import("./bootstrap");
  expect(module.getTicketBoardCapability()).toBe("pending");
  const listener = vi.fn();
  const unsubscribe = module.subscribeTicketBoardCapability(listener);
  const pending = module.loadBootstrap();
  expect(module.getTicketBoardCapability()).toBe("pending");
  const response = { me: { ticketBoardEnabled: enabled } };
  resolve(response);
  await expect(pending).resolves.toBe(response);
  expect(module.getTicketBoardCapability()).toBe(enabled ? "enabled" : "disabled");
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
});
it("disables capability and preserves the original rejection", async () => {
  const error = new Error("bootstrap unavailable");
  mocks.bootstrap.mockRejectedValue(error);
  const module = await import("./bootstrap");
  const listener = vi.fn();
  module.subscribeTicketBoardCapability(listener);
  await expect(module.loadBootstrap()).rejects.toBe(error);
  expect(module.getTicketBoardCapability()).toBe("disabled");
  expect(listener).toHaveBeenCalledOnce();
});
