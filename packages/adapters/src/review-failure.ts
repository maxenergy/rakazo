/** Copy only explicitly allowed machine facts; never retain provider payloads. */
export function reviewFailureFacts(error: unknown): {
  code?: string;
  status?: number;
} {
  if (!error || typeof error !== "object") return {};
  const value = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const allowed = [
    "insufficient_quota",
    "quota_exceeded",
    "rate_limit_exceeded",
    "rate_limit",
    "no_credentials",
    "missing_api_key",
  ];
  const code =
    typeof value.code === "string" && allowed.includes(value.code) ? value.code : undefined;
  const rawStatus = value.status ?? value.statusCode;
  const status =
    typeof rawStatus === "number" && [401, 402, 429].includes(rawStatus) ? rawStatus : undefined;
  return { ...(code ? { code } : {}), ...(status ? { status } : {}) };
}

export function reviewFailureClass(
  error: unknown,
): "quota" | "rate_limit" | "no_credentials" | undefined {
  const { code, status } = reviewFailureFacts(error);
  if (code === "insufficient_quota" || code === "quota_exceeded" || status === 402) return "quota";
  if (code === "rate_limit_exceeded" || code === "rate_limit" || status === 429)
    return "rate_limit";
  if (code === "no_credentials" || code === "missing_api_key" || status === 401)
    return "no_credentials";
  return undefined;
}
