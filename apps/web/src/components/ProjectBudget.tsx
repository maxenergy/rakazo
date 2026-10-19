import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useCallback, useId, useState } from "react";
import { rpc, selectedSpaceId } from "../lib/rpc";
import { useBoardRefresh } from "../lib/use-board-refresh";
import { errorText } from "../lib/user-error";

function usd(value: bigint) {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}$${absolute / 1000000n}.${(absolute % 1000000n).toString().padStart(6, "0")}`;
}

export function ProjectBudget({ projectId }: { projectId: string }) {
  const { t } = useLingui();
  const amountId = useId();
  const [revision, setRevision] = useState(0);
  const load = useCallback(
    (spaceId: string | null) => rpc.projects.budget({ projectId }, { context: { spaceId } }),
    [projectId, revision],
  );
  const { data: budget, error } = useBoardRefresh(load);
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>();

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={t`Project budget`}>
      <h2 className="font-medium">
        <Trans>Project budget</Trans>
      </h2>
      {budget ? (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt>
            <Trans>Limit</Trans>
          </dt>
          <dd>{usd(BigInt(budget.limitMicroUsd))}</dd>
          <dt>
            <Trans>Reserved</Trans>
          </dt>
          <dd>{usd(BigInt(budget.reservedMicroUsd))}</dd>
          <dt>
            <Trans>Settled</Trans>
          </dt>
          <dd>{usd(BigInt(budget.settledMicroUsd))}</dd>
          <dt>
            <Trans>Available</Trans>
          </dt>
          <dd>
            {usd(
              BigInt(budget.limitMicroUsd) -
                BigInt(budget.reservedMicroUsd) -
                BigInt(budget.settledMicroUsd),
            )}
          </dd>
        </dl>
      ) : budget === null ? (
        <p>
          <Trans>No project budget is configured.</Trans>
        </p>
      ) : null}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaveError(undefined);
          if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount)) {
            setSaveError(
              new Error(t`Enter a non-negative USD amount with at most six decimal places.`),
            );
            return;
          }
          const [whole, fraction = ""] = amount.split(".");
          const micro = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"));
          if (micro > 9223372036854775807n) {
            setSaveError(new Error(t`Amount exceeds the supported range.`));
            return;
          }
          const spaceId = selectedSpaceId();
          setSaving(true);
          try {
            await rpc.projects.setBudget(
              { projectId, limitMicroUsd: micro.toString() },
              { context: { spaceId } },
            );
            if (selectedSpaceId() === spaceId) {
              setAmount("");
              setRevision((value) => value + 1);
            }
          } catch (cause) {
            setSaveError(cause);
          } finally {
            setSaving(false);
          }
        }}
      >
        <label htmlFor={amountId} className="space-y-1 text-sm">
          <span>
            <Trans>Budget limit (USD)</Trans>
          </span>
          <Input
            id={amountId}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={saving}
            required
          />
        </label>
        <Button type="submit" disabled={saving || budget === undefined}>
          <Trans>Save budget</Trans>
        </Button>
      </form>
      {error || saveError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(saveError ?? error)}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        <Trans>
          Budget enforcement covers observable model calls. Fixed subscriptions and arbitrary tool
          spending are excluded.
        </Trans>
      </p>
    </section>
  );
}
