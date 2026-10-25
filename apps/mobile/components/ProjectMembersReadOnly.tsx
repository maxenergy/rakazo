import { StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

const styles = StyleSheet.create({
  card: { borderRadius: 18, gap: 10, paddingHorizontal: 16, paddingVertical: 14 },
  heading: { fontSize: 15, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8, justifyContent: "space-between" },
  name: { flex: 1, fontSize: 15 },
  role: { fontSize: 13 },
  note: { fontSize: 13 },
});

export type ProjectMemberSummary = {
  botId: string;
  name: string;
  role: "owner" | "member";
};

export function ProjectMembersReadOnly({ members }: { members: ProjectMemberSummary[] }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();

  return (
    <View style={[styles.card, { backgroundColor: tokens.card }]}>
      <Text style={[styles.heading, { color: tokens.foreground }]}>{t("Members")}</Text>
      {members.length ? (
        members.map((member) => (
          <View key={member.botId} style={styles.row}>
            <Text style={[styles.name, { color: tokens.foreground }]}>{member.name}</Text>
            <Text style={[styles.role, { color: tokens.mutedForeground }]}>
              {member.role === "owner" ? t("Owner") : t("Member")}
            </Text>
          </View>
        ))
      ) : (
        <Text style={[styles.note, { color: tokens.mutedForeground }]}>{t("No members yet.")}</Text>
      )}
      <Text style={[styles.note, { color: tokens.mutedForeground }]}>
        {t("Manage project members on web.")}
      </Text>
    </View>
  );
}
