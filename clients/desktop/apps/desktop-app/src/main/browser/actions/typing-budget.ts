import type { BrowserAutomationCommand } from '@canopy/execution-engine/types/browser';
import {
  browserTypingBudgetMs,
  BROWSER_TYPING_BUDGET_MAX_MS,
} from '@canopy/agent-actions/families/browser/typing-budget';

/** Extra lane time for keystrokes; an over-limit fill never takes its typed path. */
export function actionTypingBudgetMs(
  command: BrowserAutomationCommand,
): number {
  if (command.kind === 'type')
    return browserTypingBudgetMs(command.text.length, command.delayMs);
  if (command.kind === 'select_option')
    return browserTypingBudgetMs(command.searchText?.length ?? 0);
  if (command.kind !== 'fill') return 0;
  const budget = browserTypingBudgetMs(command.text.length);
  return budget <= BROWSER_TYPING_BUDGET_MAX_MS ? budget : 0;
}
