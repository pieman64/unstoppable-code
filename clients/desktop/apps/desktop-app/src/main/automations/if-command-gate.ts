export type { AutomationIfCommandResult } from './if-command-runner';
import type { AutomationIfCommandResult } from './if-command-runner';

export type AutomationIfCommandDecision =
  | { kind: 'run'; output: string }
  | { kind: 'skip'; message: string }
  | { kind: 'fail'; message: string };

/** Map a runner result onto the run/skip/fail run-outcome contract. */
export function decideIfCommandGate(
  result: AutomationIfCommandResult,
): AutomationIfCommandDecision {
  switch (result.outcome) {
    case 'run':
      return { kind: 'run', output: result.stdout };
    case 'skip':
      return {
        kind: 'skip',
        message: `If Command exited ${result.exitCode}; action skipped.`,
      };
    case 'error':
      return { kind: 'fail', message: `If Command failed: ${result.message}` };
  }
}
