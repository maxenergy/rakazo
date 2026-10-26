# Subscription CLI connections

Model settings offer Codex CLI, Claude Code, Antigravity CLI, and Grok CLI separately
from API-key providers. These connections invoke the unmodified official CLI;
Rakazo does not copy subscription tokens into an API adapter. Subscription
availability, models, rate limits, and any extra usage remain governed by the
account's vendor settings. There is no automatic API-key fallback.

Install the selected CLI on both the API and worker host, with its executable on
PATH. The CLI is optional; API connections and local model servers still work
without it. This also applies to container deployments: installing a CLI on the
desktop alone does not install it inside an API or worker container.

| Connection | Official CLI | Login |
| --- | --- | --- |
| Codex CLI | `@openai/codex` | ChatGPT device code |
| Claude Code | `@anthropic-ai/claude-code` or native installer | Official browser flow |
| Antigravity CLI | Native `agy` installer | Google browser sign-in with a pasted code |
| Grok CLI | `@xai-official/grok` | xAI device code |

Choose the connection and model, then sign in. Each new login gets its own
profile under the deployment's DATA_DIR. Existing personal CLI sessions are
never imported. Reconnecting replaces that provider's account and removes the
previous profile; disconnecting removes its stored profile. API and worker must
share this directory and run as the same operating-system account. CLI profiles
contain vendor-managed credentials and may contain vendor CLI session history;
treat this directory as private storage, including in backups. Unix profiles use
owner-only permissions; Windows profiles restrict access to the service account
and SYSTEM.

Codex and Grok device codes can be approved from another device. Claude Code and
Antigravity CLI use their own browser authorization flow; paste the displayed
authorization code into Rakazo when prompted. Electron leaves these callbacks
to the vendor CLI instead of trying to bind their ports.

Antigravity CLI replaces the retired personal-subscription Gemini CLI connection.
Connect it again and choose an Antigravity model slug; old Gemini CLI credentials
and API model IDs are not migrated. Rakazo checks subscription access using the
CLI's `/usage` command without an inference turn, disables automatic AI-credit
spending, and denies native file, shell, browser, and MCP actions. The installer's
standard binary location is also checked when PATH has not refreshed yet.
Its browser login runs in a private interactive terminal: print mode cannot
reliably accept pasted authorization codes and times out after one minute.
Rakazo allows up to fifteen minutes for the interactive login, then checks the
saved credential from a new headless process before storing the connection.

CLI connections currently accept text. The model catalog advertises this so
image workflows can select another connection. Replies arrive when the CLI
finishes its inference turn. Rakazo passes the conversation and tool definitions
in a structured prompt, validates requested tool names and object arguments, and
executes those tools through its normal authorized sandbox/integration path.
The CLI's own tools, extensions, hooks, and inherited server API credentials are
disabled or excluded. Each request uses a temporary working directory and has
bounded output, cancellation, and a timeout.

Official references:

- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Claude Code authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
- [Antigravity CLI installation and authentication](https://antigravity.google/docs/cli/install/)
- [Antigravity CLI headless protocol](https://antigravity.google/docs/cli/headless/)
- [Grok CLI authentication](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)
- [Grok headless interface](https://docs.x.ai/build/cli/headless-scripting)
