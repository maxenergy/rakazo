// @vitest-environment jsdom
import { act, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ subscribe: vi.fn(), space: "space-1" }));
vi.mock("./rpc", () => ({
  rpc: { boards: { subscribe: api.subscribe } },
  selectedSpaceId: () => api.space,
}));

import { useBoardRefresh } from "./use-board-refresh";

afterEach(() => {
  vi.unstubAllGlobals();
  api.space = "space-1";
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("ignores an old filter response after the new filter loads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.subscribe.mockResolvedValue({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  });
  const old = deferred<string>();
  const load = vi.fn((filter: string) =>
    filter === "old" ? old.promise : Promise.resolve("new result"),
  );
  function View({ filter }: { filter: string }) {
    const fetch = useCallback(() => load(filter), [filter]);
    const { data } = useBoardRefresh(fetch);
    return <div>{data}</div>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<View filter="old" />));
    await act(async () => root.render(<View filter="new" />));
    expect(container.textContent).toBe("new result");
    await act(async () => old.resolve("old result"));
    expect(container.textContent).toBe("new result");
  } finally {
    await act(async () => root.unmount());
  }
});

it("rejects a response from a previously selected space", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.subscribe.mockResolvedValue({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  });
  const pending = deferred<string>();
  const load = vi.fn(() => pending.promise);
  function View() {
    const { data } = useBoardRefresh<string>(load);
    return <div>{data}</div>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<View />));
    expect(load).toHaveBeenCalledWith("space-1");
    api.space = "space-2";
    await act(async () => pending.resolve("foreign result"));
    expect(container.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
  }
});

it("reads after subscribing and rereads on a space heartbeat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let deliver!: (value: IteratorResult<{ spaceId: string }>) => void;
  api.subscribe.mockResolvedValue({
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<{ spaceId: string }>>((resolve) => {
          deliver = resolve;
        }),
    }),
  });
  const load = vi
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce("initial")
    .mockResolvedValue("refreshed");
  function View() {
    const { data } = useBoardRefresh<string>(load);
    return <div>{data}</div>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<View />));
    expect(container.textContent).toBe("initial");
    await act(async () => deliver({ done: false, value: { spaceId: "space-1" } }));
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("refreshed");
  } finally {
    await act(async () => root.unmount());
  }
});

it("rereads authoritative progress after reconnect and stops retrying on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  api.subscribe
    .mockReset()
    .mockResolvedValueOnce({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    })
    .mockResolvedValue({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    });
  const load = vi.fn<() => Promise<string>>().mockResolvedValueOnce("1/2").mockResolvedValue("2/2");
  function View() {
    const { data } = useBoardRefresh(load);
    return <div>{data}</div>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  let unmounted = false;
  try {
    await act(async () => root.render(<View />));
    expect(container.textContent).toBe("1/2");
    expect(api.subscribe.mock.calls[0]![1].signal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(api.subscribe).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("2/2");
    await act(async () => root.unmount());
    unmounted = true;
    expect(api.subscribe.mock.calls[1]![1].signal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(api.subscribe).toHaveBeenCalledTimes(2);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
