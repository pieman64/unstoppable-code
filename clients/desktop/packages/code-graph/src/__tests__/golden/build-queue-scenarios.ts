/**
 * Build queue scenarios: queue classes, first-build insertion and aging,
 * single-flight promotion, stronger follow-ups, the background slot and its
 * pacing, user reordering, cancellation and teardown, driven step by step on
 * a virtual clock. A build names a graph key (`key`, defaulting to its id);
 * builds sharing a key share one queue entry.
 */
export type GoldenBuildClass =
  | 'agent'
  | 'first-build'
  | 'worktree'
  | 'maintenance';

export type BuildQueueStep =
  | {
      build: string;
      class: GoldenBuildClass;
      key?: string;
      /** Ask for a content-verifying (or full reparse) build. */
      verify?: boolean;
      forceReparse?: boolean;
      /** The project the build belongs to; availability is per project. */
      project?: string;
    }
  | { advance: number }
  /** The worker building `key` answers. */
  | { complete: string; outcome: 'ok' | 'failed' }
  /** The worker building `key` exits before answering. */
  | { crash: string }
  | { cancel: string }
  /** Reorder the queued entries by label, at the current or a stale revision. */
  | { reorder: readonly string[]; stale?: boolean }
  | { snapshot: true }
  /** Turn code graph generation off for one project. */
  | { disableProject: string }
  | { teardown: true };

export interface BuildQueueScenario {
  name: string;
  steps: readonly BuildQueueStep[];
}

export const BUILD_QUEUE_SCENARIOS: readonly BuildQueueScenario[] = [
  {
    name: 'class-order',
    steps: [
      { build: 'running-refresh', class: 'worktree' },
      { build: 'running-agent', class: 'agent' },
      { build: 'refresh', class: 'worktree' },
      { build: 'maintenance', class: 'maintenance' },
      { build: 'first', class: 'first-build' },
      { build: 'agent', class: 'agent' },
      { snapshot: true },
      { complete: 'running-agent', outcome: 'ok' },
      { complete: 'running-refresh', outcome: 'ok' },
      { snapshot: true },
      { advance: 499 },
      { advance: 1 },
      { complete: 'agent', outcome: 'ok' },
      { complete: 'first', outcome: 'ok' },
      { advance: 500 },
      { complete: 'refresh', outcome: 'ok' },
      { advance: 500 },
      { complete: 'maintenance', outcome: 'ok' },
      { snapshot: true },
    ],
  },
  {
    name: 'first-build-aging',
    steps: [
      { build: 'running', class: 'worktree' },
      { build: 'refresh-1', class: 'worktree' },
      { build: 'first-1', class: 'first-build' },
      { build: 'first-2', class: 'first-build' },
      { build: 'first-3', class: 'first-build' },
      { build: 'first-4', class: 'first-build' },
      { build: 'refresh-2', class: 'worktree' },
      { build: 'first-5', class: 'first-build' },
      { snapshot: true },
      { teardown: true },
    ],
  },
  {
    name: 'single-flight-promotion',
    steps: [
      { build: 'running', class: 'worktree' },
      { build: 'refresh', class: 'worktree' },
      { build: 'other-refresh', class: 'worktree' },
      { build: 'first', class: 'first-build' },
      { build: 'refresh-as-first', class: 'first-build', key: 'refresh' },
      { snapshot: true },
      { build: 'other-as-agent', class: 'agent', key: 'other-refresh' },
      { snapshot: true },
      { complete: 'other-refresh', outcome: 'ok' },
      { complete: 'running', outcome: 'ok' },
      { advance: 500 },
      { snapshot: true },
      { teardown: true },
    ],
  },
  {
    name: 'stronger-request-follows-running-build',
    steps: [
      { build: 'plain', class: 'worktree', key: 'k' },
      { build: 'same', class: 'worktree', key: 'k' },
      { build: 'verify', class: 'worktree', key: 'k', verify: true },
      { build: 'reparse', class: 'agent', key: 'k', forceReparse: true },
      { complete: 'k', outcome: 'ok' },
      { complete: 'k', outcome: 'ok' },
      { build: 'queued-plain', class: 'worktree', key: 'q' },
      { build: 'queued-verify', class: 'agent', key: 'q', verify: true },
      { complete: 'q', outcome: 'failed' },
    ],
  },
  {
    name: 'user-reorder',
    steps: [
      { build: 'running', class: 'worktree' },
      { build: 'a', class: 'worktree' },
      { build: 'b', class: 'first-build' },
      { build: 'c', class: 'maintenance' },
      { reorder: ['c', 'a', 'b'], stale: true },
      { reorder: ['c', 'a'] },
      { reorder: ['c', 'a', 'z'] },
      { reorder: ['c', 'a', 'b'] },
      { build: 'late-agent', class: 'agent' },
      { build: 'late-first', class: 'first-build' },
      { snapshot: true },
      { complete: 'running', outcome: 'ok' },
      { advance: 500 },
      { snapshot: true },
      { teardown: true },
    ],
  },
  {
    name: 'failures-cancellation-and-teardown',
    steps: [
      { build: 'crash', class: 'agent' },
      { crash: 'crash' },
      { build: 'timeout', class: 'agent' },
      { build: 'queued', class: 'worktree' },
      { build: 'queued-2', class: 'worktree' },
      { cancel: 'queued-2' },
      { advance: 1_799_999 },
      { advance: 1 },
      { disableProject: 'disabled-project' },
      { build: 'unavailable', class: 'agent', project: 'disabled-project' },
      { build: 'running-cancel', class: 'agent' },
      { cancel: 'running-cancel' },
      { build: 'last', class: 'maintenance' },
      { teardown: true },
      { build: 'after-teardown', class: 'agent' },
      { complete: 'after-teardown', outcome: 'ok' },
    ],
  },
];
