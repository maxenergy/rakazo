import { Trans, useLingui } from "@lingui/react/macro";
import type { Goal, KeyResult } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import type { FormEvent } from "react";
import { useId, useState } from "react";

type Fields = {
  name: string;
  description: string | null;
  state: Goal["state"];
  dueAt: string | null;
};
type ResultFields = Fields & {
  measure: string;
  currentValue: number;
  targetValue: number;
  calculationRule: string;
  milestoneId: string | null;
};
type Props = {
  initial?: Goal | KeyResult;
  kind: "goal" | "result";
  pending: boolean;
  milestones?: { id: string; name: string; archived: boolean }[];
  onSave: (fields: Fields | ResultFields) => Promise<void>;
};

export function GoalEditor({ initial, kind, pending, milestones = [], onSave }: Props) {
  const { t } = useLingui();
  const formId = useId();
  const result = initial && "measure" in initial ? initial : undefined;
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [state, setState] = useState<Goal["state"]>(initial?.state ?? "planned");
  const [dueAt, setDueAt] = useState(initial?.dueAt?.slice(0, 10) ?? "");
  const [measure, setMeasure] = useState(result?.measure ?? "");
  const [currentValue, setCurrentValue] = useState(String(result?.currentValue ?? 0));
  const [targetValue, setTargetValue] = useState(String(result?.targetValue ?? 1));
  const [calculationRule, setCalculationRule] = useState(result?.calculationRule ?? "");
  const [milestoneId, setMilestoneId] = useState(result?.milestoneId ?? "");
  const unavailableMilestone = Boolean(
    milestoneId && !milestones.some((item) => item.id === milestoneId && !item.archived),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || (kind === "result" && unavailableMilestone)) return;
    const fields: Fields = {
      name: name.trim(),
      description: description || null,
      state,
      dueAt: dueAt ? new Date(`${dueAt}T00:00:00.000Z`).toISOString() : null,
    };
    if (kind === "result") {
      if (
        !currentValue.trim() ||
        !targetValue.trim() ||
        !Number.isFinite(Number(currentValue)) ||
        !Number.isFinite(Number(targetValue))
      )
        return;
      await onSave({
        ...fields,
        measure: measure.trim(),
        currentValue: Number(currentValue),
        targetValue: Number(targetValue),
        calculationRule: calculationRule.trim(),
        milestoneId: milestoneId || null,
      });
    } else await onSave(fields);
  }
  return (
    <form onSubmit={submit} className="min-w-0 space-y-3">
      <fieldset disabled={pending} className="min-w-0 space-y-3">
        <label htmlFor={`${formId}-name`} className="block space-y-1 text-sm">
          <span>
            <Trans>Name</Trans>
          </span>
          <Input
            id={`${formId}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label htmlFor={`${formId}-description`} className="block space-y-1 text-sm">
          <span>
            <Trans>Description</Trans>
          </span>
          <Textarea
            id={`${formId}-description`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={20000}
          />
        </label>
        <label htmlFor={`${formId}-state`} className="block space-y-1 text-sm">
          <span id={`${formId}-state-label`}>
            <Trans>State</Trans>
          </span>
          <NativeSelect
            id={`${formId}-state`}
            aria-labelledby={`${formId}-state-label`}
            value={state}
            onChange={(event) => setState(event.target.value as Goal["state"])}
          >
            <NativeSelectOption value="planned">{t`Planned`}</NativeSelectOption>
            <NativeSelectOption value="active">{t`Active`}</NativeSelectOption>
            <NativeSelectOption value="achieved">{t`Achieved`}</NativeSelectOption>
            <NativeSelectOption value="cancelled">{t`Cancelled`}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label htmlFor={`${formId}-due-date`} className="block space-y-1 text-sm">
          <span>
            <Trans>Due date</Trans>
          </span>
          <Input
            id={`${formId}-due-date`}
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </label>
        {kind === "result" ? (
          <>
            <label htmlFor={`${formId}-measure`} className="block space-y-1 text-sm">
              <span>
                <Trans>Measure</Trans>
              </span>
              <Input
                id={`${formId}-measure`}
                value={measure}
                onChange={(event) => setMeasure(event.target.value)}
                required
                maxLength={200}
              />
            </label>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <label htmlFor={`${formId}-current-value`} className="min-w-0 space-y-1 text-sm">
                <span>
                  <Trans>Current value</Trans>
                </span>
                <Input
                  id={`${formId}-current-value`}
                  type="number"
                  step="any"
                  required
                  value={currentValue}
                  onChange={(event) => setCurrentValue(event.target.value)}
                />
              </label>
              <label htmlFor={`${formId}-target-value`} className="min-w-0 space-y-1 text-sm">
                <span>
                  <Trans>Target value</Trans>
                </span>
                <Input
                  id={`${formId}-target-value`}
                  type="number"
                  step="any"
                  required
                  value={targetValue}
                  onChange={(event) => setTargetValue(event.target.value)}
                />
              </label>
            </div>
            <label htmlFor={`${formId}-calculation-rule`} className="block space-y-1 text-sm">
              <span>
                <Trans>Calculation rule</Trans>
              </span>
              <Textarea
                id={`${formId}-calculation-rule`}
                required
                value={calculationRule}
                onChange={(event) => setCalculationRule(event.target.value)}
                maxLength={20000}
              />
            </label>
            <label htmlFor={`${formId}-milestone`} className="block space-y-1 text-sm">
              <span id={`${formId}-milestone-label`}>
                <Trans>Milestone</Trans>
              </span>
              <NativeSelect
                id={`${formId}-milestone`}
                aria-labelledby={`${formId}-milestone-label`}
                value={milestoneId}
                onChange={(event) => setMilestoneId(event.target.value)}
              >
                <NativeSelectOption value="">{t`None`}</NativeSelectOption>
                {milestones
                  .filter((item) => !item.archived)
                  .map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {item.name}
                    </NativeSelectOption>
                  ))}
                {milestoneId &&
                !milestones.some((item) => item.id === milestoneId && !item.archived) ? (
                  <NativeSelectOption
                    value={milestoneId}
                    disabled
                  >{t`Archived milestone`}</NativeSelectOption>
                ) : null}
              </NativeSelect>
              {unavailableMilestone ? (
                <p role="status">
                  <Trans>Clear or replace the archived milestone before saving.</Trans>
                </p>
              ) : null}
            </label>
          </>
        ) : null}
        <Button
          type="submit"
          disabled={
            !name.trim() ||
            (kind === "result" &&
              (!measure.trim() || !calculationRule.trim() || unavailableMilestone))
          }
        >
          <Trans>Save</Trans>
        </Button>
      </fieldset>
    </form>
  );
}
