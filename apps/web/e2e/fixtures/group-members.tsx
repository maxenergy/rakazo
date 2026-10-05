import { I18nProvider } from "@lingui/react";
import type { Bot, Group } from "@rakazo/contracts";
import type { AvatarStyle } from "@rakazo/ui-web";
import { AvatarStyleProvider, GROK_BOT_COLORS } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { CreateGroupForm, GroupSettings } from "../../src/pages/GroupPanel";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const variant: AvatarStyle = params.get("variant") === "organic" ? "organic" : "robot";
const creating = params.get("view") === "create";
const date = "2026-01-01T00:00:00.000Z";
const bots: Bot[] = ["Researcher", "Writer", "Reviewer", "Archived"].map((name, index) => ({
  id: `fixture-bot-${index}`,
  spaceId: "fixture-space",
  name,
  title: "",
  description: "",
  instructions: "",
  color: GROK_BOT_COLORS[index]!,
  notifyOnFinish: false,
  pinned: false,
  sectionId: null,
  archivedAt: index === 3 ? date : null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: `fixture-thread-${index}`,
  preview: "",
  status: "running",
  computerMode: "team",
  updatedAt: date,
  createdAt: date,
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  spawnKey: null,
}));
const group: Group = {
  id: "fixture-group",
  spaceId: "fixture-space",
  name: "Draft team",
  pinned: false,
  sectionId: null,
  archivedAt: null,
  members: bots.slice(0, 2).map(({ id, name, color }) => ({ botId: id, name, color })),
  threadId: "fixture-group-thread",
  preview: "",
  unread: false,
  updatedAt: date,
  createdAt: date,
};

function Fixture() {
  const [refresh, setRefresh] = useState(0);
  const [saved, setSaved] = useState<unknown>(null);
  useEffect(() => {
    const timer = setInterval(() => setRefresh((value) => value + 1), 3_000);
    return () => clearInterval(timer);
  }, []);
  const refreshedBots = bots.map((bot) => ({
    ...bot,
    status: refresh % 2 === 0 ? "running" : "idle",
  }));

  return (
    <AvatarStyleProvider value={variant}>
      <main className="w-[400px] bg-background p-6" data-testid="group-panel">
        {creating ? (
          <CreateGroupForm
            bots={refreshedBots}
            onCancel={() => {}}
            onCreate={async (input) => setSaved(input)}
          />
        ) : (
          <GroupSettings
            group={{ ...group, members: group.members.map((member) => ({ ...member })) }}
            bots={refreshedBots}
            onSave={async (input) => setSaved(input)}
            onRemove={async () => {}}
          />
        )}
      </main>
      <output data-testid="refresh-count" hidden>
        {refresh}
      </output>
      <output data-testid="saved-input" hidden>
        {JSON.stringify(saved)}
      </output>
    </AvatarStyleProvider>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <Fixture />
    </I18nProvider>,
  );
});
