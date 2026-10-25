import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  type ProjectMemberSummary,
  ProjectMembersReadOnly,
} from "../components/ProjectMembersReadOnly";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

type Project = {
  id: string;
  name: string;
  status: "active" | "paused";
  owner: { botId: string } | null;
  pausedAt: string | null;
  archived?: boolean;
  inFlightRuns?: { id: string; status: string; externalProcessState: "needs_confirmation" }[];
  cancellationRequests?: { id: string; externalProcessState: "needs_confirmation" }[];
};
type Membership = { botId: string; role: "owner" | "member" };

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 14 },
  title: { fontSize: 22, fontWeight: "700" },
  card: { borderRadius: 16, padding: 14, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  name: { flex: 1, fontSize: 16, fontWeight: "600" },
  muted: { fontSize: 13 },
  back: { paddingVertical: 8 },
});

export default function ProjectsScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [members, setMembers] = useState<ProjectMemberSummary[]>([]);
  const [ownerName, setOwnerName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await rpc<Project[]>("projects/list", { archived: false });
      setProjects(result);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  async function toggleProject(project: Project) {
    const status = project.status === "paused" ? "active" : "paused";
    Alert.alert(
      status === "paused" ? t("Pause project?") : t("Resume project?"),
      status === "paused" ? t("In flight work will finish safely.") : undefined,
      [
        { text: t("Cancel"), style: "cancel" },
        { text: status === "paused" ? t("Pause") : t("Resume"), onPress: () => {
          void rpc<Project>("projects/update", { id: project.id, status }).then(async (updated) => {
            setSelected(updated);
            await loadProjects();
          }).catch((cause: unknown) => setError(String(cause)));
        } },
      ],
    );
  }

  async function openProject(project: Project) {
    setSelected(project);
    setLoading(true);
    try { const detail = await rpc<Project>("projects/get", { id: project.id }); setSelected(detail); project = detail; } catch (cause) { setError(String(cause)); }
    try {
      const rows = await rpc<Membership[]>("projects/members", { projectId: project.id });
      const summaries = await Promise.all(
        rows.map(async (row) => {
          const bot = await rpc<{
            id: string;
            name: string;
            archivedAt: string | null;
            modelProvider: string | null;
            modelId: string | null;
          }>("bots/get", { botId: row.botId });
          return {
            botId: row.botId,
            name: bot.name,
            role: row.role,
            status: bot.archivedAt ? ("archived" as const) : ("active" as const),
            model: bot.modelProvider && bot.modelId ? `${bot.modelProvider}/${bot.modelId}` : null,
          };
        }),
      );
      setMembers(summaries);
      if (project.owner) {
        const owner = await rpc<{ name: string }>("bots/get", { botId: project.owner.botId });
        setOwnerName(owner.name);
      } else setOwnerName(t("No project owner assigned."));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView
      style={{ backgroundColor: tokens.background }}
      contentContainerStyle={styles.screen}
    >
      {selected ? (
        <Pressable
          onPress={() => {
            setSelected(null);
            setError("");
          }}
          style={styles.back}
        >
          <Text style={{ color: tokens.primary }}>{t("Back to projects")}</Text>
        </Pressable>
      ) : null}
      <Text style={[styles.title, { color: tokens.foreground }]}>
        {selected?.name ?? t("Projects")}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
      {loading ? <ActivityIndicator color={tokens.secondary} /> : null}
      {!selected ? (
        projects.map((project) => (
          <Pressable
            key={project.id}
            onPress={() => void openProject(project)}
            style={[styles.card, { backgroundColor: tokens.card }]}
          >
            <View style={styles.row}>
              <Text style={[styles.name, { color: tokens.foreground }]}>{project.name}</Text>
              <Text style={[styles.muted, { color: tokens.mutedForeground }]}>
                {project.status === "paused" ? t("Paused") : t("Active")}
              </Text>
            </View>
          </Pressable>
        ))
      ) : (
        <>
          <View style={[styles.card, { backgroundColor: tokens.card }]}>
            <Text style={{ color: tokens.foreground }}>
              {selected.status === "paused" ? t("Paused") : t("Active")}
              {selected.pausedAt ? " · " + new Date(selected.pausedAt).toLocaleString() : ""}
            </Text>
            <Pressable accessibilityRole="button" disabled={selected.archived} onPress={() => toggleProject(selected)} style={styles.back}>
              <Text style={{ color: tokens.primary }}>{selected.status === "paused" ? t("Resume project") : t("Pause project")}</Text>
            </Pressable>
            {selected.status === "paused" ? selected.inFlightRuns?.map((run) => (
              <Text key={run.id} style={[styles.muted, { color: tokens.mutedForeground }]}>{t("Finishing safely")}: {run.id} ({run.status})</Text>
            )) : null}
            {selected.cancellationRequests?.map((run) => (
              <Text key={run.id} style={[styles.muted, { color: tokens.mutedForeground }]}>{t("Cancellation requested; external process needs manual confirmation and is not shown as stopped.")} ({run.id})</Text>
            ))}
            <Text style={[styles.muted, { color: tokens.mutedForeground }]}>
              {t("Owner")}: {ownerName || t("Loading")}
            </Text>
          </View>
          <ProjectMembersReadOnly members={members} />
        </>
      )}
      <Pressable onPress={() => router.push("/")} style={styles.back}>
        <Text style={{ color: tokens.primary }}>{t("Home")}</Text>
      </Pressable>
    </ScrollView>
  );
}
