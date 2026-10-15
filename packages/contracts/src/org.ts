import * as z from "zod";

/** ceo and cto form the launch team; lead runs a team; member does the work. */
export const BOT_ORG_ROLES = ["ceo", "cto", "lead", "member"] as const;
export const BotOrgRoleSchema = z.enum(BOT_ORG_ROLES);
export type BotOrgRole = z.infer<typeof BotOrgRoleSchema>;

export const BOT_TEAM_MAX_LENGTH = 60;

/** Roles that may create (staff) other bots once a bot is part of the org. */
const STAFFING_ROLES: ReadonlySet<BotOrgRole> = new Set(["ceo", "cto", "lead"]);

export function parseBotOrgRole(value: string | null | undefined): BotOrgRole | null {
  const parsed = BotOrgRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A bot outside the org (null role) keeps unrestricted spawning. */
export function orgRoleCanStaff(role: BotOrgRole | null): boolean {
  return role === null || STAFFING_ROLES.has(role);
}
