// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  boards: { subscribe: vi.fn() },
  bots: { list: vi.fn() },
  projects: { list: vi.fn() },
  milestones: { list: vi.fn() },
  tickets: {
    list: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    comment: vi.fn(),
    comments: vi.fn(),
    dependencies: vi
      .fn()
      .mockResolvedValue({ prerequisites: [], dependents: [], blockedByDependency: false }),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
  },
}));
vi.mock("../lib/rpc", () => ({ rpc: api, selectedSpaceId: () => "space-1" }));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "5m ago" }));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => (
    <div data-testid="chat-markdown">{children}</div>
  ),
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  };
});

import { BoardPage } from "./Board";

beforeEach(() => {
  api.projects.list.mockReset().mockResolvedValue([]);
  api.milestones.list.mockReset().mockResolvedValue([]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

function bot(id: string, name: string) {
  return { id, name };
}

function ticket(
  title: string,
  id: string,
  status = "todo",
  ref = "RAK-1",
  assigneeBotId: string | null = null,
  description: string | null = null,
) {
  return {
    id,
    boardId: "board-1",
    spaceId: "space-1",
    number: 1,
    ref,
    title,
    description,
    status,
    priority: "normal",
    assigneeBotId,
    createdByBotId: null,
    createdByUserId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
  };
}

async function renderBoard(
  stream?: AsyncIterable<{ ticketId?: string; spaceId?: string }>,
  path = "/app/board",
) {
  api.boards.subscribe.mockReset();
  api.boards.subscribe.mockResolvedValue(
    stream ?? {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <BoardPage />
      </MemoryRouter>,
    ),
  );
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("renders status columns and opens a ticket with comments", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1", "Details")],
  });
  api.tickets.comments.mockResolvedValue([
    {
      id: "comment-1",
      body: "Ready",
      authorName: "Board tester",
      createdAt: "2026-10-10T10:00:00Z",
    },
    { id: "comment-2", body: "Reviewed", authorName: "Helper", createdAt: "2026-10-10T10:01:00Z" },
  ]);
  const page = await renderBoard();
  try {
    expect(
      Array.from(page.container.querySelectorAll("h2")).map((node) => node.textContent),
    ).toEqual(["To do", "In progress", "In review", "Blocked", "Done", "Won't do"]);
    await act(async () =>
      (
        page.container.querySelector('[data-testid="board-card-ticket-1"]') as HTMLButtonElement
      ).click(),
    );
    expect(page.container.querySelector('[data-testid="ticket-description"]')?.textContent).toBe(
      "Details",
    );
    expect(page.container.querySelector('[data-testid="ticket-comments"]')?.textContent).toContain(
      "Ready",
    );
    const comments = page.container.querySelector('[data-testid="ticket-comments"]')!;
    expect(comments.textContent).toContain("Board tester");
    expect(comments.textContent).toContain("Helper");
    expect(Array.from(comments.querySelectorAll("time")).map((node) => node.textContent)).toEqual([
      "5m ago",
      "5m ago",
    ]);
    expect(
      Array.from(page.container.querySelectorAll("select")).every((node) =>
        node.classList.contains("w-full"),
      ),
    ).toBe(true);
    const submitButtons = page.container.querySelectorAll('button[type="submit"]');
    expect(Array.from(submitButtons).map((node) => node.parentElement?.className)).toEqual([
      "flex justify-end",
      "flex justify-end",
    ]);
    expect(api.tickets.comments).toHaveBeenCalledWith({ ticketId: "ticket-1" });
  } finally {
    await page.cleanup();
  }
});

it("creates a ticket without a status picker", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list.mockResolvedValue({ tickets: [] });
  api.tickets.create.mockResolvedValue({});
  const page = await renderBoard();
  try {
    expect(page.container.textContent).toContain("No tickets yet");
    await act(async () =>
      Array.from(page.container.querySelectorAll("button"))
        .find((button) => button.textContent === "New ticket")!
        .click(),
    );
    expect(
      Array.from(page.container.querySelector("form")!.querySelectorAll("label")).map(
        (label) => label.textContent,
      ),
    ).not.toContain("Status");
    const input = page.container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Launch",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      page.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.tickets.create).toHaveBeenCalledWith({
      title: "Launch",
      description: "",
      assigneeBotId: "bot-1",
      priority: "normal",
    });
  } finally {
    await page.cleanup();
  }
});

it("discards a load-more response after changing filters and keeps normal pagination", async () => {
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  let resolvePage!: (value: unknown) => void;
  api.tickets.list
    .mockReset()
    .mockResolvedValueOnce({ items: [ticket("First", "ticket-1")], nextCursor: "cursor-1" })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    )
    .mockResolvedValue({ items: [ticket("Filtered", "ticket-3", "done")] });
  const page = await renderBoard(undefined, "/app/tickets");
  try {
    const loadButton = () =>
      Array.from(page.container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Load more"),
      );
    await act(async () => {
      while (!loadButton()) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = loadButton();
    if (!button) throw new Error("Load more button did not render");
    await act(async () => button.click());
    const status = page.container.querySelectorAll("select")[2] as HTMLSelectElement;
    await act(async () => {
      status.value = "done";
      status.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () =>
      resolvePage({ items: [ticket("Stale", "ticket-stale")], nextCursor: null }),
    );
    expect(page.container.textContent).not.toContain("Stale");
    expect(api.tickets.list).toHaveBeenCalledTimes(3);

    api.tickets.list.mockResolvedValueOnce({
      items: [ticket("Second", "ticket-2")],
      nextCursor: null,
    });
    const nextButton = loadButton();
    if (!nextButton) throw new Error("Load more button did not render after filtering");
    await act(async () => nextButton.click());
    expect(page.container.textContent).toContain("Second");
  } finally {
    await page.cleanup();
  }
});

it("discards a load-more response after a board refresh", async () => {
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  let resolvePage!: (value: unknown) => void;
  api.tickets.list
    .mockReset()
    .mockResolvedValueOnce({ items: [ticket("First", "ticket-1")], nextCursor: "cursor-1" })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    )
    .mockResolvedValue({ items: [ticket("Refreshed", "ticket-2")], nextCursor: "cursor-2" });
  const live = liveStream();
  const page = await renderBoard(live.stream, "/app/tickets");
  try {
    const loadButton = () =>
      Array.from(page.container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Load more"),
      );
    await act(async () => {
      while (!loadButton()) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = loadButton();
    if (!button) throw new Error("Load more button did not render");
    await act(async () => button.click());
    await act(async () => {
      live.event("ticket-1");
      await Promise.resolve();
    });
    await act(async () =>
      resolvePage({ items: [ticket("Stale refresh page", "ticket-stale")], nextCursor: null }),
    );
    expect(page.container.textContent).not.toContain("Stale refresh page");
  } finally {
    await page.cleanup();
  }
});

function liveStream() {
  let deliver:
    | ((result: IteratorResult<{ ticketId?: string; spaceId?: string }>) => void)
    | undefined;
  let fail: ((cause: Error) => void) | undefined;
  return {
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<{ ticketId?: string; spaceId?: string }>>(
            (resolve, reject) => {
              deliver = resolve;
              fail = reject;
            },
          ),
      }),
    },
    event: (ticketId: string) =>
      deliver?.({ done: false, value: { ticketId, spaceId: "space-1" } }),
    end: () => deliver?.({ done: true, value: undefined }),
    error: () => fail?.(new Error("Disconnected")),
  };
}

it("saves only edits and refreshes comments for the open ticket", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper"), bot("bot-2", "Other")]);
  api.tickets.list.mockResolvedValue({
    tickets: [ticket("Ship", "ticket-1", "todo", "RAK-1", "bot-1", "Details")],
  });
  api.tickets.comments.mockReset().mockResolvedValue([{ id: "comment-1", body: "Ready" }]);
  api.tickets.update.mockReset().mockResolvedValue({});
  const live = liveStream();
  const page = await renderBoard(live.stream);
  try {
    await act(async () =>
      (
        page.container.querySelector('[data-testid="board-card-ticket-1"]') as HTMLButtonElement
      ).click(),
    );
    const calls = api.tickets.comments.mock.calls.length;
    await act(async () => live.event("ticket-2"));
    expect(api.tickets.comments.mock.calls.length).toBeGreaterThan(calls);
    api.tickets.comments.mockResolvedValue([{ id: "comment-2", body: "Bot progress" }]);
    api.tickets.list.mockResolvedValue({
      tickets: [ticket("Ship", "ticket-1", "doing", "RAK-1", "bot-2", "Details")],
    });
    await act(async () => live.event("ticket-1"));
    expect(page.container.querySelector('[data-testid="ticket-comments"]')?.textContent).toContain(
      "Bot progress",
    );
    const input = page.container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Ship today",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      page.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.tickets.update).toHaveBeenCalledWith({ id: "ticket-1", title: "Ship today" });
  } finally {
    await page.cleanup();
  }
});

it("closes the subscription before retrying a failed ticket refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
  api.tickets.list
    .mockReset()
    .mockRejectedValueOnce(new Error("Refresh failed"))
    .mockResolvedValue({ tickets: [ticket("After retry", "ticket-1")] });
  const next = vi.fn(
    () => new Promise<IteratorResult<{ ticketId?: string; spaceId?: string }>>(() => {}),
  );
  const page = await renderBoard({ [Symbol.asyncIterator]: () => ({ next }) });
  try {
    const firstSignal = api.boards.subscribe.mock.calls[0]![1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(api.boards.subscribe).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(api.boards.subscribe).toHaveBeenCalledTimes(2);
    const retrySignal = api.boards.subscribe.mock.calls[1]![1].signal as AbortSignal;
    expect(retrySignal).not.toBe(firstSignal);
    expect(retrySignal.aborted).toBe(false);
    expect(page.container.textContent).toContain("After retry");

    await page.cleanup();
    expect(retrySignal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(api.boards.subscribe).toHaveBeenCalledTimes(2);
  } finally {
    if (page.container.isConnected) await page.cleanup();
    vi.useRealTimers();
  }
});

it.each(["end", "error"] as const)(
  "reconnects after subscription %s and stops on unmount",
  async (failure) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
    api.tickets.list.mockReset().mockResolvedValue({ tickets: [] });
    const live = liveStream();
    const page = await renderBoard(live.stream);
    try {
      const reconnected = liveStream();
      api.boards.subscribe.mockResolvedValue(reconnected.stream);
      await act(async () => live[failure]());
      const calls = api.tickets.list.mock.calls.length;
      api.tickets.list.mockResolvedValue({ tickets: [ticket("After reconnect", "ticket-1")] });
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(api.boards.subscribe).toHaveBeenCalledTimes(2);
      expect(api.tickets.list).toHaveBeenCalledTimes(calls + 1);
      expect(page.container.textContent).toContain("After reconnect");
      await act(async () => reconnected.end());
      await page.cleanup();
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(api.boards.subscribe).toHaveBeenCalledTimes(2);
      expect(api.boards.subscribe.mock.calls[1]![1].signal.aborted).toBe(true);
    } finally {
      if (page.container.isConnected) await page.cleanup();
      vi.useRealTimers();
    }
  },
);

it.each([360, 390])(
  "uses a list and minimal filters at %ipx even on the board route",
  async (width) => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: width < 768,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    api.bots.list.mockResolvedValue([bot("bot-1", "Helper")]);
    api.tickets.list
      .mockReset()
      .mockResolvedValue({ tickets: [ticket("Narrow ticket", "narrow")] });
    const page = await renderBoard();
    try {
      expect(page.container.querySelector('[data-testid="ticket-list"]')).not.toBeNull();
      expect(page.container.querySelector('[data-testid="board-columns"]')).toBeNull();
      expect(
        Array.from(page.container.querySelectorAll("button")).some(
          (node) => node.textContent === "Board",
        ),
      ).toBe(false);
      expect(page.container.querySelectorAll("select")).toHaveLength(3);
      expect(
        Array.from(page.container.querySelectorAll("select")).map(
          (select) => select.labels?.[0]?.textContent,
        ),
      ).toEqual(["Project", "Milestone", "Status"]);
      const newTicketButton = Array.from(page.container.querySelectorAll("button")).find(
        (button) => button.textContent === "New ticket",
      )!;
      expect(newTicketButton.disabled).toBe(false);
      await act(async () => newTicketButton.click());
      const form = page.container.querySelector("form");
      expect(form).not.toBeNull();
      expect(
        form!.querySelector<HTMLSelectElement>('select[id$="-project"]')?.labels?.[0]?.textContent,
      ).toBe("Project");
      expect(
        form!.querySelector<HTMLSelectElement>('select[id$="-milestone"]')?.labels?.[0]
          ?.textContent,
      ).toBe("Milestone");
    } finally {
      await page.cleanup();
    }
  },
);

it("sends unassociated and status filters explicitly", async () => {
  api.bots.list.mockResolvedValue([]);
  api.tickets.list.mockReset().mockResolvedValue({ tickets: [] });
  const page = await renderBoard(
    undefined,
    "/app/tickets?projectId=none&milestoneId=none&status=done",
  );
  try {
    expect(api.tickets.list).toHaveBeenCalledWith(
      { projectId: null, milestoneId: null, status: "done", limit: 100 },
      { context: { spaceId: "space-1" } },
    );
  } finally {
    await page.cleanup();
  }
});

it("loads more tickets, deduplicates by id, and shows the loaded count", async () => {
  api.bots.list.mockResolvedValue([]);
  api.tickets.list
    .mockReset()
    .mockResolvedValueOnce({ items: [ticket("First", "ticket-1")], nextCursor: "opaque-next" })
    .mockResolvedValueOnce({
      items: [ticket("Changed title", "ticket-1"), ticket("Second", "ticket-2")],
      nextCursor: null,
    });
  const page = await renderBoard();
  try {
    expect(page.container.textContent).toContain("Loaded 1");
    expect(api.tickets.list).toHaveBeenNthCalledWith(
      1,
      { limit: 100 },
      { context: { spaceId: "space-1" } },
    );
    await act(async () => {
      Array.from(page.container.querySelectorAll("button"))
        .find((button) => button.textContent === "Load more")!
        .click();
    });
    expect(api.tickets.list).toHaveBeenNthCalledWith(
      2,
      { limit: 100, cursor: "opaque-next" },
      expect.objectContaining({
        context: { spaceId: "space-1" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(page.container.textContent).toContain("Loaded 2");
    expect(page.container.querySelectorAll('[data-testid^="board-card-"]')).toHaveLength(2);
    expect(page.container.textContent).toContain("First");
    expect(page.container.textContent).toContain("Second");
    expect(
      Array.from(page.container.querySelectorAll("button")).some(
        (button) => button.textContent === "Load more",
      ),
    ).toBe(false);
  } finally {
    await page.cleanup();
  }
});
