// Hook trigger catalog shared by the desktop hook runner and the Portal hooks
// section. Array order is dispatch and display order.

export const WORKTREE_HOOK_TRIGGERS = ['worktree:precommit:failure'] as const;

/** A requeue reports `pr:queue:removed` before `pr:queue:entered`. */
export const PR_HOOK_TRIGGERS = [
  'pr:create',
  'pr:update:comments',
  'pr:reviews:new',
  'pr:reviews:new:has-comments',
  'pr:update:labels',
  'pr:checks:fail',
  'pr:checks:pass',
  'pr:checks:pass:all',
  'pr:checks:finished',
  'pr:checks:finished:has-fail',
  'pr:merge-conflicts',
  'pr:queue:removed',
  'pr:queue:entered',
  'pr:merged',
  'pr:closed',
] as const;

export const HOOK_TRIGGERS = [
  ...WORKTREE_HOOK_TRIGGERS,
  ...PR_HOOK_TRIGGERS,
] as const;

export type HookTriggerName = (typeof HOOK_TRIGGERS)[number];

export const HOOK_TRIGGER_DISPLAY_LABELS: Readonly<
  Record<HookTriggerName, string>
> = {
  'worktree:precommit:failure': 'Pre-commit Failure',
  'pr:create': 'PR Created',
  'pr:reviews:new': 'New PR Review Submitted',
  'pr:reviews:new:has-comments': 'New PR Review With Inline Comments',
  'pr:merged': 'PR Merged',
  'pr:closed': 'PR Closed',
  'pr:update:comments': 'PR Comments Updated',
  'pr:update:labels': 'PR Labels Updated',
  'pr:checks:fail': 'PR Check Failed',
  'pr:checks:pass': 'PR Check Passed',
  'pr:checks:pass:all': 'All PR Checks Passed',
  'pr:checks:finished': 'PR Checks Finished',
  'pr:checks:finished:has-fail': 'PR Checks Finished With Failures',
  'pr:merge-conflicts': 'PR Merge Conflicts Detected',
  'pr:queue:entered': 'PR Entered Merge Queue',
  'pr:queue:removed': 'PR Removed From Merge Queue',
};

const HOOK_TRIGGER_INDEX = new Map<string, number>(
  HOOK_TRIGGERS.map((triggerName, index) => [triggerName, index]),
);

export function isHookTriggerName(value: string): value is HookTriggerName {
  return HOOK_TRIGGER_INDEX.has(value);
}

/** Catalog position of a known trigger; -1 for unknown or custom triggers. */
export function hookTriggerIndex(triggerName: string): number {
  return HOOK_TRIGGER_INDEX.get(triggerName) ?? -1;
}
