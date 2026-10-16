import type { BotOrgRole } from "@rakazo/contracts";
import { parseBotOrgRole } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

export type OrgMember = {
  id: string;
  name: string;
  orgRole: BotOrgRole;
  team: string;
  reportsToBotId: string | null;
};

const ROLE_DUTIES: Record<BotOrgRole, string> = {
  ceo: "You and the CTO run this company and make its decisions. You own goals, plans, staffing, progress, and reporting to the user. Agree each plan with the CTO, record the decision with record_decision, then act on it. When you hand a plan to the CTO for review, end your turn; the CTO messages you its verdict.",
  cto: "You and the CEO run this company and make its decisions. You own technical plans, architecture, and reviews, and you help any bot that escalates a hard technical problem to you. When the CEO hands you a plan, write your full review in your reply, never only a pointer to it, then send your verdict to the CEO with message_bot (intent result) so the CEO is woken to decide. A handoff cannot go back to the bot that sent it.",
  lead: "You run your team: split the work, give each member a clear task, check results, and report progress to the bot you report to.",
  member:
    "Do the tasks you are given and report results to the bot you report to. You cannot create bots; ask the bot you report to when you need more help.",
};

/**
 * The launch team decides most things itself; the user keeps only goal changes,
 * new spending, irreversible or outward actions, and deadlocks.
 */
const DECISION_RULE = [
  "Decision authority: the CEO and CTO decide together, without the user, on technical approach and architecture, staffing (creating and archiving bots, choosing their models), milestones and plans, and spending within the existing subscriptions and free resources. The CEO records each such decision with record_decision and the team acts on it.",
  "Only these go to the user with submit_proposal: changing the user's goal or scope, any new paid spending, irreversible or outward-facing actions (production data, deleting data, public releases, payments), and anything the CEO and CTO cannot agree on. For these, only a decision the user records on the Approvals page counts; a chat reply does not, so ask the user to decide there and wait for the decision message.",
].join(" ");

function label(member: OrgMember) {
  return `${member.name} (${member.orgRole}, id ${member.id})`;
}

/** Org guidance for one bot, or undefined when it has no org role. */
export function renderOrgContext(self: OrgMember | null, org: readonly OrgMember[]) {
  if (!self) return undefined;
  const byId = new Map(org.map((member) => [member.id, member]));
  const manager = self.reportsToBotId ? byId.get(self.reportsToBotId) : undefined;
  const reports = org.filter((member) => member.reportsToBotId === self.id);
  const ceo = org.find((member) => member.orgRole === "ceo" && member.id !== self.id);
  const cto = org.find((member) => member.orgRole === "cto" && member.id !== self.id);

  const lines = [
    DECISION_RULE,
    `Org: you are the ${self.orgRole}${self.team ? ` on team ${self.team}` : ""}. ${ROLE_DUTIES[self.orgRole]}`,
    `You report to ${manager ? label(manager) : "the user"}.`,
    reports.length
      ? `Your direct reports: ${reports.map((member) => `${label(member)}${member.team ? `, team ${member.team}` : ""}`).join("; ")}.`
      : undefined,
    cto && self.orgRole !== "cto"
      ? `For a hard technical problem you cannot solve, escalate it (kind technical) to the CTO, ${label(cto)}, with what you tried.`
      : undefined,
    ceo && self.orgRole !== "ceo"
      ? `For a decision you cannot make yourself, escalate it (kind decision) to the CEO, ${label(ceo)}. The CEO and CTO decide it.`
      : "For a decision, agree with the CTO and record it with record_decision. Send it to the user with submit_proposal only when it is one of the user-level items above.",
    "Follow through: before you end a turn, check whether the next step of your assigned work is yours. If it is, do it now instead of ending with a status report. When you reply to an older message, act on the newest instructions you have, not only on that message.",
    "Each turn sees every message in your thread, including colleagues' messages newer than the one that woke you. Handle all of them in this turn and answer whoever needs a reply with message_bot: a message you have already seen does not wake you again.",
    "To reach any colleague, including one outside a group chat you are in, use message_bot; it wakes them. handoff_to_bot only passes a stage to another member of the current group.",
  ];
  return lines.filter(Boolean).join("\n");
}

export async function loadOrgContext(
  prisma: PrismaClient,
  bot: { id: string; spaceId: string; userId: string; orgRole: string | null },
) {
  if (!parseBotOrgRole(bot.orgRole)) return undefined;
  const rows = await prisma.bot.findMany({
    where: {
      spaceId: bot.spaceId,
      userId: bot.userId,
      archivedAt: null,
      orgRole: { not: null },
    },
    select: { id: true, name: true, orgRole: true, team: true, reportsToBotId: true },
    orderBy: { createdAt: "asc" },
  });
  const org = rows.flatMap((row) => {
    const orgRole = parseBotOrgRole(row.orgRole);
    return orgRole ? [{ ...row, orgRole }] : [];
  });
  return renderOrgContext(org.find((member) => member.id === bot.id) ?? null, org);
}

/** The active CEO or CTO in this bot's space, if the org has one. */
export async function findOrgExecutive(
  prisma: PrismaClient,
  bot: { spaceId: string; userId: string },
  role: "ceo" | "cto",
) {
  return prisma.bot.findFirst({
    where: { spaceId: bot.spaceId, userId: bot.userId, archivedAt: null, orgRole: role },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Where an escalation goes, or why it cannot go anywhere. */
export function escalationTarget(
  kind: "technical" | "decision",
  self: { id: string; orgRole: BotOrgRole | null },
  executives: {
    ceo: { id: string; name: string } | null;
    cto: { id: string; name: string } | null;
  },
): { ok: true; target: { id: string; name: string } } | { ok: false; error: string } {
  if (!self.orgRole) {
    return { ok: false, error: "escalate needs an org role. Use message_bot instead." };
  }
  if (kind === "technical") {
    if (self.orgRole === "cto") {
      return {
        ok: false,
        error: "You are the CTO. Solve it yourself, or escalate a decision to the CEO.",
      };
    }
    return executives.cto && executives.cto.id !== self.id
      ? { ok: true, target: executives.cto }
      : { ok: false, error: "This org has no CTO to escalate to." };
  }
  if (self.orgRole === "ceo") {
    return { ok: false, error: "You are the CEO. Use submit_proposal to ask the user." };
  }
  return executives.ceo && executives.ceo.id !== self.id
    ? { ok: true, target: executives.ceo }
    : { ok: false, error: "This org has no CEO to escalate to." };
}
