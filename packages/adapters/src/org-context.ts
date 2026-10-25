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
  ceo: "You and the CTO run this company and make its decisions. You own goals, plans, staffing, progress, and reporting to the user. Agree each plan with the CTO, record the decision with record_decision, then act on it. When you hand a plan to the CTO for review, end your turn; the CTO messages you its verdict. When a milestone or ticket is finished, or a blocker needs the user, post one short report with report_to_group: what was finished, the evidence (PR and CI links), what comes next, and what is needed from the user (or none). Only you report there, and never with progress updates. Before hiring or changing a bot's model, check model_scorecard and choose by results and cost.",
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
  "Decision authority: the CEO and CTO decide together, without the user, on technical approach and architecture, staffing (creating and archiving bots, choosing their models), milestones and plans, and spending within the existing subscriptions and free resources. The CEO records each such decision with record_decision and the team acts on it. Record only decisions that change the plan, scope, staffing, architecture or spending; test order, retries, schedules and other working steps are not decisions.",
  "Only these go to the user with submit_proposal: changing the user's goal or scope, any new paid spending, irreversible or outward-facing actions (production data, deleting data, public releases, payments), and anything the CEO and CTO cannot agree on. For these, only a decision the user records on the Approvals page counts; a chat reply does not, so ask the user to decide there and wait for the decision message.",
].join(" ");

/**
 * Org bots mostly read each other, tools and English system text, so without this they
 * drift into English even when the user writes in another language.
 */
const LANGUAGE_RULE =
  "Language: write everything (replies, group reports, messages to colleagues, ticket comments, decisions and proposals) in the language the user writes to the team, even when colleagues, tickets or tools use another language. Keep code, commands, paths, identifiers and commit messages as they are.";

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
    LANGUAGE_RULE,
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
    "Keep messages few: message a colleague only to hand over work, to ask about something that blocks you, or to report a finished step with its result. Do not send progress updates, acknowledgements or thanks, and do not restate another bot's message to a third bot; point the bot that needs it to the source instead.",
    "When the user or a colleague needs to see a screenshot, image or file, attach it with attach_file so it shows in the chat; a file name or path alone cannot be reviewed. Attaching keeps the file in this Rakazo and is not an external upload.",
    "Each turn sees every message in your thread, including colleagues' messages newer than the one that woke you. Handle all of them in this turn and answer whoever needs a reply with message_bot: a message you have already seen does not wake you again.",
    "To reach any colleague, including one outside a group chat you are in, use message_bot; it wakes them. handoff_to_bot only passes a stage to another member of the current group.",
    "When a ticket must wait for another ticket, record it with ticket_dependency_add and set the ticket blocked; its owner is woken when the prerequisite is done. A wait written only in text or chat wakes no one. A comment on a ticket wakes its owner.",
    "A ticket assigned to you whose prerequisites are done is your go-ahead: start it now and move it to doing. Do not wait for another dispatch or confirmation from the CEO, the CTO or a lead; the assignment is the dispatch. Wait only for the user-level approvals named above or for a prerequisite recorded with ticket_dependency_add. When you assign a ticket, write it so the owner can start at once, without a second go-ahead.",
    "When a run of yours or a colleague's failed or stopped, call run_failures to see why before retrying or asking anyone; fix the cause when it is yours.",
    "Team lessons: the shared skill named team-lessons holds proven know-how for this team. Read it with skill_read before starting work in an area it covers. After a ticket of yours is done with its change merged and CI green, add anything reusable you proved (a workaround, a pitfall, a working command or check) in at most three lines, with skill_update on team-lessons (skill_create it if missing). Record only what worked; never guesses, failed attempts or task status.",
  ];
  return lines.filter(Boolean).join("\n");
}

export async function loadOrgContext(
  prisma: PrismaClient,
  bot: { id: string; spaceId: string; userId: string; orgRole: string | null },
  projectId?: string | null,
) {
  if (!parseBotOrgRole(bot.orgRole)) return undefined;
  const rows = await prisma.bot.findMany({
    where: {
      spaceId: bot.spaceId,
      userId: bot.userId,
      archivedAt: null,
      orgRole: { not: null },
      ...(projectId ? { projectMemberships: { some: { projectId } } } : {}),
    },
    select: { id: true, name: true, orgRole: true, team: true, reportsToBotId: true },
    orderBy: { createdAt: "asc" },
  });
  const org = rows.flatMap((row) => {
    const orgRole = parseBotOrgRole(row.orgRole);
    return orgRole ? [{ ...row, orgRole }] : [];
  });
  const self = org.find((member) => member.id === bot.id) ?? null;
  const rendered = renderOrgContext(self, org);
  // The CEO and CTO submit proposals and must not duplicate one the user has not decided.
  if (!rendered || (self?.orgRole !== "ceo" && self?.orgRole !== "cto")) return rendered;
  const pending = await prisma.proposal.findMany({
    where: { spaceId: bot.spaceId, userId: bot.userId, status: "pending" },
    select: { title: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 10,
  });
  return `${rendered}
${pendingProposalsLine(pending)}`;
}

/** What waits on the user in the Approvals page, so bots never have to ask to see it. */
export function pendingProposalsLine(pending: readonly { title: string; createdAt: Date }[]) {
  if (pending.length === 0)
    return "Proposals waiting on the user's decision: none. You can submit a new one without checking the Approvals page.";
  return `Proposals waiting on the user's decision (do not submit a duplicate): ${pending
    .map((proposal) => `"${proposal.title}" (${proposal.createdAt.toISOString().slice(0, 16)}Z)`)
    .join("; ")}.`;
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
