import { Trans, useLingui } from "@lingui/react/macro";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useId, useState } from "react";

export type ProjectMember = {
  botId: string;
  name: string;
  role: "owner" | "member";
};

export type ProjectPersonOption = {
  botId: string;
  name: string;
};

type Props = {
  members: ProjectMember[];
  people: ProjectPersonOption[];
  pending?: boolean;
  onAdd: (botId: string) => Promise<void>;
  onRemove: (botId: string) => Promise<void>;
  onSetOwner: (botId: string | null) => Promise<void>;
};

export function ProjectMembers({
  members,
  people,
  pending = false,
  onAdd,
  onRemove,
  onSetOwner,
}: Props) {
  const { t } = useLingui();
  const selectId = useId();
  const [selectedBotId, setSelectedBotId] = useState("");
  const [error, setError] = useState<unknown>();
  const [busyBotId, setBusyBotId] = useState<string | null>(null);
  const availablePeople = people.filter(
    (person) => !members.some((member) => member.botId === person.botId),
  );

  async function mutate(botId: string, action: () => Promise<void>) {
    setError(undefined);
    setBusyBotId(botId);
    try {
      await action();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusyBotId(null);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={t`Project members`}>
      <h2 className="font-medium">
        <Trans>Members</Trans>
      </h2>
      {members.length ? (
        <ul className="space-y-2">
          {members.map((member) => (
            <li key={member.botId} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 break-words">{member.name}</span>
              {member.role === "owner" ? (
                <>
                  <span className="text-sm text-muted-foreground">
                    <Trans>Owner</Trans>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending || busyBotId !== null}
                    onClick={() => void mutate(member.botId, () => onSetOwner(null))}
                  >
                    <Trans>Clear owner</Trans>
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending || busyBotId !== null}
                  onClick={() => void mutate(member.botId, () => onSetOwner(member.botId))}
                >
                  <Trans>Set owner</Trans>
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={pending || busyBotId !== null}
                onClick={() => void mutate(member.botId, () => onRemove(member.botId))}
              >
                <Trans>Remove</Trans>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>No members yet.</Trans>
        </p>
      )}
      {!members.some((member) => member.role === "owner") ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No project owner assigned.</Trans>
        </p>
      ) : null}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!selectedBotId || pending || busyBotId !== null) return;
          void mutate(selectedBotId, async () => {
            await onAdd(selectedBotId);
            setSelectedBotId("");
          });
        }}
      >
        <label htmlFor={selectId} className="space-y-1 text-sm">
          <span>
            <Trans>Add member</Trans>
          </span>
          <NativeSelect
            id={selectId}
            value={selectedBotId}
            disabled={pending || busyBotId !== null || availablePeople.length === 0}
            onChange={(event) => setSelectedBotId(event.target.value)}
          >
            <NativeSelectOption value="">
              <Trans>Select a person</Trans>
            </NativeSelectOption>
            {availablePeople.map((person) => (
              <NativeSelectOption key={person.botId} value={person.botId}>
                {person.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <Button
          type="submit"
          variant="outline"
          disabled={!selectedBotId || pending || busyBotId !== null}
        >
          <Trans>Add</Trans>
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {String(error)}
        </p>
      ) : null}
    </section>
  );
}
