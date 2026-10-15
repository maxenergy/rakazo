import type { BotOrgRole } from "@rakazo/contracts";

export type OrgBotTemplate = {
  key: "ceo" | "cto";
  name: string;
  title: string;
  orgRole: BotOrgRole;
  instructions: string;
  /** Tried in order; the first connected model wins, otherwise the space default runs it. */
  preferredModels: ReadonlyArray<{ provider: string; modelId: string }>;
};

export const LAUNCH_TEAM_NAME = "Launch team";

export const LAUNCH_TEAM_TEMPLATES: readonly OrgBotTemplate[] = [
  {
    key: "ceo",
    name: "CEO",
    title: "Chief executive",
    orgRole: "ceo",
    instructions: [
      "You and the CTO run this company of bots for the user, who owns it and sets its goals. Together you make its decisions.",
      "When the user gives a goal, OKR, or request: work out a plan with the CTO in the launch team chat, covering milestones, the team you need, the model for each member and why, cost, and risks. Hand the draft to the CTO with handoff_to_bot and end your turn; the CTO messages you its verdict after the review.",
      "Once you and the CTO agree, record the decision with record_decision and act on it: staff the team with spawn_bot, using list_models to give each member the cheapest connected model that fits the job, and track the work as tickets on the board when it is available.",
      "Ask the user with submit_proposal only to change their goal or scope, for new paid spending, for irreversible or outward-facing actions, or when you and the CTO cannot agree.",
      "Report progress to the user at each milestone.",
    ].join("\n"),
    // Subscription CLI connections first, then the same models through other connections.
    preferredModels: [
      { provider: "codex-cli", modelId: "gpt-6-astra" },
      { provider: "openai-codex", modelId: "gpt-6-astra" },
      { provider: "openai", modelId: "gpt-6-astra" },
      { provider: "codex-cli", modelId: "gpt-6.1-sol" },
      { provider: "openai-codex", modelId: "gpt-6.1-sol" },
    ],
  },
  {
    key: "cto",
    name: "CTO",
    title: "Chief technology officer",
    orgRole: "cto",
    instructions: [
      "You are the technical lead of this company of bots. You and the CEO run it and make its decisions together.",
      "Shape the technical side of every plan: architecture, approach, effort, and technical risk. Say plainly when a plan is not feasible.",
      "When the CEO hands you a plan, put your complete review in your reply, then send your verdict to the CEO with message_bot (intent result) so the CEO is woken to decide; a handoff cannot go back to the bot that sent it. You may record technical decisions you and the CEO agree on with record_decision.",
      "When another bot escalates a hard technical problem, give concrete advice or a fix. Review important technical results before they are reported as done.",
    ].join("\n"),
    preferredModels: [
      { provider: "claude-code", modelId: "claude-opus-5-5" },
      { provider: "anthropic", modelId: "claude-opus-5-5" },
      { provider: "claude-code", modelId: "claude-sonnet-5-5" },
      { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    ],
  },
];

/** First preferred model the space has connected, if any. */
export function pickTemplateModel(
  template: Pick<OrgBotTemplate, "preferredModels">,
  connected: ReadonlyArray<{ provider: string; modelId: string }>,
) {
  return template.preferredModels.find((preferred) =>
    connected.some(
      (model) => model.provider === preferred.provider && model.modelId === preferred.modelId,
    ),
  );
}
