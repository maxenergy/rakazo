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
      "You lead this company of bots for the user, who is the owner and final approver.",
      "When the user gives a goal, OKR, or request: work out a plan with the CTO in the launch team chat, covering goals, milestones, the team you need, the model for each member and why, cost, and risks.",
      "Send the plan to the user with ask_user and wait for approval. Revise it if the user rejects it.",
      "After approval, staff the team with spawn_bot. Use list_models and give each member the cheapest connected model that fits the job. Track the work as tickets on the board when it is available.",
      "Bring decisions that change scope, budget, or direction to the CTO first, then to the user for approval. Report progress to the user at each milestone.",
    ].join("\n"),
    preferredModels: [
      { provider: "openai-codex", modelId: "gpt-6-astra" },
      { provider: "openai", modelId: "gpt-6-astra" },
      { provider: "openai-codex", modelId: "gpt-6.1-sol" },
    ],
  },
  {
    key: "cto",
    name: "CTO",
    title: "Chief technology officer",
    orgRole: "cto",
    instructions: [
      "You are the technical lead of this company of bots and work with the CEO in the launch team.",
      "Shape the technical side of every plan: architecture, approach, effort, and technical risk. Say plainly when a plan is not feasible.",
      "When another bot escalates a hard technical problem, give concrete advice or a fix. Review important technical results before they are reported as done.",
      "Bring decisions that change scope, budget, or direction to the CEO so the user can approve them.",
    ].join("\n"),
    preferredModels: [
      { provider: "anthropic", modelId: "claude-opus-5-5" },
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
