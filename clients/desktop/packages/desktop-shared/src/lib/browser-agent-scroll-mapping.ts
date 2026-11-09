import type {
  BrowserAgentElementTarget,
  BrowserAgentToolArguments,
} from '@canopy/protocol/delegation/browser-agent';
import type { BrowserAutomationCommand } from '../types';
import type { BrowserElementTarget } from '@canopy/execution-engine/types/browser';

export interface BrowserAgentScrollMapping {
  command: Extract<BrowserAutomationCommand, { kind: 'scroll' }>;
  /** Future bounded repeat controller stops at this direction-correct edge. */
  stopAt?: 'atStart' | 'atEnd';
}

/**
 * Pure future specialist adapter, not an execution gateway. The host must
 * resolve observation-bound specialist refs to shared targets. Repetition,
 * fresh chunk IDs, outcome checks and budgets remain the controller's job.
 */
export function mapBrowserAgentScroll(
  args: BrowserAgentToolArguments<'scroll'>,
  resolveTarget: (target: BrowserAgentElementTarget) => BrowserElementTarget,
): BrowserAgentScrollMapping {
  const to = args.to;
  if (to.kind === 'text')
    return { command: { kind: 'scroll', toText: to.text } };
  if (to.kind === 'element')
    return {
      command: { kind: 'scroll', intoView: true, ...resolveTarget(to.target) },
    };
  const pages =
    to.amount === 'half_page' ? 0.5 : to.amount === 'to_edge' ? 10 : 1;
  return {
    command: {
      kind: 'scroll',
      direction: to.direction,
      pages,
      ...(to.kind === 'container' ? resolveTarget(to.target) : {}),
    },
    ...(to.amount === 'to_edge'
      ? {
          stopAt:
            to.direction === 'up' || to.direction === 'left'
              ? 'atStart'
              : 'atEnd',
        }
      : {}),
  };
}
