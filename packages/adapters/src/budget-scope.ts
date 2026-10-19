import { AsyncLocalStorage } from "node:async_hooks";
import type { BudgetCallScope } from "./budget-observer.js";

const storage = new AsyncLocalStorage<BudgetCallScope | null>();

/** Bind the budget scope (space + project) for every model call made inside fn. */
export function runWithBudgetScope<T>(scope: BudgetCallScope | null, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Scope for the current run, or null when the run has no project attribution. */
export function currentBudgetScope(): BudgetCallScope | null {
  return storage.getStore() ?? null;
}
