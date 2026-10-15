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
  ceo: "You own goals, plans, staffing, progress, and reporting to the user. Draft each plan with the CTO, then get the user's approval with ask_user before you staff a team or start the work.",
  cto: "You own technical plans, architecture, and reviews. Work out plans with the CEO, and help any bot that escalates a hard technical problem to you.",
  lead: "You run your team: split the work, give each member a clear task, check results, and report progress to the bot you report to.",
  member:
    "Do the tasks you are given and report results to the bot you report to. You cannot create bots; ask the bot you report to when you need more help.",
};

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
    `Org: you are the ${self.orgRole}${self.team ? ` on team ${self.team}` : ""}. ${ROLE_DUTIES[self.orgRole]}`,
    `You report to ${manager ? label(manager) : "the user"}.`,
    reports.length
      ? `Your direct reports: ${reports.map((member) => `${label(member)}${member.team ? `, team ${member.team}` : ""}`).join("; ")}.`
      : undefined,
    cto && self.orgRole !== "cto"
      ? `For a hard technical problem you cannot solve, message_bot the CTO, ${label(cto)}, with what you tried.`
      : undefined,
    ceo && self.orgRole !== "ceo"
      ? `For a decision that changes scope, budget, or direction, message_bot the CEO, ${label(ceo)}. The CEO and CTO agree on a recommendation and the CEO asks the user before anyone acts on it.`
      : "For a decision that changes scope, budget, or direction, agree on a recommendation with the CTO, then ask the user with ask_user before acting on it.",
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
