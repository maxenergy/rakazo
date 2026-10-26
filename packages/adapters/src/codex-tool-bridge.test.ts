import { afterEach, describe, expect, it } from "vitest";
import { CodexToolBridge } from "./codex-tool-bridge.js";

const tools = [
  {
    name: "shell",
    description: "Run a command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  },
];

let bridge: CodexToolBridge | undefined;
afterEach(() => bridge?.close());

async function rpc(url: string, token: string | undefined, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

describe("CodexToolBridge", () => {
  it("rejects requests without the run's secret", async () => {
    bridge = new CodexToolBridge(tools);
    const url = await bridge.start();
    expect((await rpc(url, undefined, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await rpc(url, "wrong", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  it("lists the run's tools and hands each call to Rakazo until it answers", async () => {
    bridge = new CodexToolBridge(tools);
    const url = await bridge.start();
    const init = await rpc(url, bridge.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(
      (await rpc(url, bridge.token, { jsonrpc: "2.0", method: "notifications/initialized" }))
        .status,
    ).toBe(202);
    const list = await rpc(url, bridge.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.body.result.tools).toEqual([
      { name: "shell", description: "Run a command", inputSchema: tools[0]!.parameters },
    ]);

    const next = bridge.nextCalls();
    const call = rpc(url, bridge.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "shell", arguments: { command: "ls" } },
    });
    const [handed] = await next;
    expect(handed).toMatchObject({ name: "shell", arguments: { command: "ls" } });
    expect(bridge.pendingIds()).toEqual([handed!.id]);
    bridge.resolve(handed!.id, { content: [{ type: "text", text: "a.txt" }] });
    expect((await call).body.result).toEqual({ content: [{ type: "text", text: "a.txt" }] });
  });

  it("refuses tools outside the run's tool set and fails waiting calls on close", async () => {
    bridge = new CodexToolBridge(tools);
    const url = await bridge.start();
    const unknown = await rpc(url, bridge.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    expect(unknown.body.result.isError).toBe(true);
    const next = bridge.nextCalls();
    const call = rpc(url, bridge.token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "shell", arguments: {} },
    });
    await next;
    bridge.close();
    expect((await call).body.result.isError).toBe(true);
  });
});
