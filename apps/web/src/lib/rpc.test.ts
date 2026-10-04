import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSpaceSelection, selectedSpaceId, selectSpace, withSpaceHeaders } from "./rpc.js";

vi.mock("./i18n", () => ({ getActiveUiLocale: () => "zh-CN" }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("space selection storage", () => {
  it("sends the selected interface language while preserving other request headers", () => {
    const headers = withSpaceHeaders(
      {
        "accept-language": "en-US,en;q=0.9",
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      "space-support",
    );
    expect(headers.get("accept-language")).toBe("zh-CN");
    expect(headers.get("x-rakazo-space-id")).toBe("space-support");
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("content-type")).toBe("application/json");
  });
  it("reports localStorage write failures without throwing", () => {
    const localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("quota exceeded");
      },
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(false);
    expect(() => clearSpaceSelection()).not.toThrow();
    expect(selectedSpaceId()).toBeNull();
  });

  it("treats an already-persisted selection as success when writes fail", () => {
    const localStorage = {
      getItem: (key: string) => (key === "rakazo:space-id" ? "space-support" : null),
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: vi.fn(),
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(selectSpace("space-other")).toBe(false);
  });

  it("reports when a space selection was persisted", () => {
    const setItem = vi.fn();
    const localStorage = { getItem: () => null, setItem, removeItem: vi.fn() };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(setItem).toHaveBeenCalledWith("rakazo:space-id", "space-support");
  });
});
