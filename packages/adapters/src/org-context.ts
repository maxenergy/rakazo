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
  ceo: "You own goals, plans, staffing, progress, and reporting to the user. Draft each plan with the CTO, then get the user's approval with submit_proposal before you staff a team or start the work. When you hand a plan to the CTO for review, end your turn; the CTO hands it back to you for submission.",
  cto: "You own technical plans, architecture, and reviews. Work out plans with the CEO, and help any bot that escalates a hard technical problem to you. When the CEO hands you a plan, write your full review in your reply, never only a pointer to it, then hand the next stage back to the CEO with handoff_to_bot so the CEO can submit the proposal.",
  lead: "You run your team: split the work, give each member a clear task, check results, and report progress to the bot you report to.",
  member:
    "Do the tasks you are given and report results to the bot you report to. You cannot create bots; ask the bot you report to when you need more help.",
};

/** Chat replies are easy to misread as sign-off; only a recorded decision counts. */
const APPROVAL_RULE =
  "Only a decision the user records on the Approvals page counts as approval. If the user approves, agrees, or says to continue in chat, do not treat it as approval: ask them to decide the pending proposal on the Approvals page, and wait for that decision, which arrives as a new message.";

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
    APPROVAL_RULE,
    `Org: you are the ${self.orgRole}${self.team ? ` on team ${self.team}` : ""}. ${ROLE_DUTIES[self.orgRole]}`,
    `You report to ${manager ? label(manager) : "the user"}.`,
    reports.length
      ? `Your direct reports: ${reports.map((member) => `${label(member)}${member.team ? `, team ${member.team}` : ""}`).join("; ")}.`
      : undefined,
    cto && self.orgRole !== "cto"
      ? `For a hard technical problem you cannot solve, escalate it (kind technical) to the CTO, ${label(cto)}, with what you tried.`
      : undefined,
    ceo && self.orgRole !== "ceo"
      ? `For a decision that changes scope, budget, or direction, escalate it (kind decision) to the CEO, ${label(ceo)}. The CEO and CTO agree on a recommendation and the CEO asks the user before anyone acts on it.`
      : "For a decision that changes scope, budget, or direction, agree on a recommendation with the CTO, then send it to the user with submit_proposal and wait for the decision before acting on it.",
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
