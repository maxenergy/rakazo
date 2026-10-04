/** Recognize product-authored catalog copy while keeping provider/model names as data. */
export function modelBillingCopy(text: string) {
  const api = /^Uses your (.+?) (?:API key|key)\. Rakazo does not pay for model usage\.$/.exec(
    text,
  );
  if (api) return { kind: "api" as const, name: api[1]! };
  if (
    text ===
    "Runs on infrastructure configured by the deployment owner. No model charges from Rakazo."
  )
    return { kind: "local" as const };
  if (text === "Runs on a URL you control. Rakazo does not pay for model usage.")
    return { kind: "custom" as const };
  if (text === "No model charges. Deterministic fixture for tests.")
    return { kind: "fixture" as const };
  const configured = /^Configured via PI_DEFAULT_MODEL \((.+)\)\.$/.exec(text);
  if (configured) return { kind: "configured" as const, name: configured[1]! };
  const unavailable =
    /^(.+) subscription login is not in the Rakazo UI yet\. Skip if this deployment already has credentials\.$/.exec(
      text,
    );
  if (unavailable) return { kind: "unavailable" as const, name: unavailable[1]! };
  if (
    text === "Sign in with ChatGPT Plus or Pro. Uses your OpenAI subscription. Rakazo does not pay."
  )
    return { kind: "subscription" as const, name: "ChatGPT Plus / Pro" };
  if (text === "Sign in with GitHub Copilot. Uses your Copilot subscription. Rakazo does not pay.")
    return { kind: "subscription" as const, name: "GitHub Copilot" };
  if (text === "Sign in with SuperGrok or X Premium, or paste an xAI API key. Rakazo does not pay.")
    return { kind: "grok" as const };
  return { kind: "literal" as const, text };
}
