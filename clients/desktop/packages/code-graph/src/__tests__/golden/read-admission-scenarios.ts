/**
 * Read admission scenarios: the bounded read lane's classes, limits, deadlines,
 * aging, worker reuse and refusals, driven step by step on a virtual clock.
 * Steps name reads by id and keys by worktree; a binding maps each task class
 * onto its host's read request and reports what callers and processes see.
 */
export type GoldenReadTaskClass =
  /** An agent tool query (`calls`). */
  | 'query'
  /** The UI summary (`readonly-summary`). */
  | 'summary'
  /** Shadow maintenance reading a published base's summary. */
  | 'base-summary'
  | 'detect-changed'
  | 'change-impact'
  | 'fingerprint-metadata'
  | 'persist-fingerprint'
  | 'validate-base'
  | 'base-identity';

export type GoldenWorkerReply =
  | 'ok'
  /** A worker failure answer classified `busy`. */
  | 'failure-busy'
  /** A summary answer whose database read failed as busy. */
  | 'summary-busy'
  | 'malformed';

export type ReadAdmissionStep =
  | {
      read: string;
      key: string;
      task: GoldenReadTaskClass;
      /** Issue this many reads, named `${read}1`…`${read}N`. */
      count?: number;
    }
  | { advance: number }
  | { reply: string; with: GoldenWorkerReply }
  /** The process serving the read exits before answering. */
  | { crash: string }
  | { cancelKey: string }
  | { cancelProject: string }
  | { fenceKey: string }
  | { releaseFence: string }
  | { shutdown: true };

export interface ReadAdmissionScenario {
  name: string;
  steps: readonly ReadAdmissionStep[];
}

const A = 'project/a';
const B = 'project/b';
const C = 'project/c';
const D = 'project/d';
const E = 'project/e';
const F = 'project/f';

/** Three interactive reads on distinct keys occupy every interactive slot. */
const FILL_INTERACTIVE: readonly ReadAdmissionStep[] = [
  { read: 'i1', key: A, task: 'query' },
  { read: 'i2', key: B, task: 'query' },
  { read: 'i3', key: C, task: 'summary' },
];

export const READ_ADMISSION_SCENARIOS: readonly ReadAdmissionScenario[] = [
  {
    name: 'classes-and-active-limits',
    steps: [
      ...FILL_INTERACTIVE,
      { read: 'i4', key: D, task: 'query' },
      { read: 'c1', key: E, task: 'detect-changed' },
      { read: 'c2', key: F, task: 'change-impact' },
      { read: 'm1', key: F, task: 'fingerprint-metadata' },
      { reply: 'i1', with: 'ok' },
      { reply: 'c1', with: 'ok' },
      { reply: 'i2', with: 'ok' },
      { reply: 'i3', with: 'ok' },
      { reply: 'i4', with: 'ok' },
      { reply: 'c2', with: 'ok' },
      { reply: 'm1', with: 'ok' },
    ],
  },
  {
    name: 'task-class-assignment',
    steps: [
      { read: 'query', key: A, task: 'query' },
      { reply: 'query', with: 'ok' },
      { read: 'summary', key: A, task: 'summary' },
      { reply: 'summary', with: 'ok' },
      { read: 'base-summary', key: A, task: 'base-summary' },
      { reply: 'base-summary', with: 'ok' },
      { read: 'detect', key: A, task: 'detect-changed' },
      { reply: 'detect', with: 'ok' },
      { read: 'impact', key: A, task: 'change-impact' },
      { reply: 'impact', with: 'ok' },
      { read: 'metadata', key: A, task: 'fingerprint-metadata' },
      { reply: 'metadata', with: 'ok' },
      { read: 'persist', key: A, task: 'persist-fingerprint' },
      { reply: 'persist', with: 'ok' },
      { read: 'validate', key: A, task: 'validate-base' },
      { reply: 'validate', with: 'ok' },
      { read: 'identity', key: A, task: 'base-identity' },
      { reply: 'identity', with: 'ok' },
    ],
  },
  {
    name: 'interactive-queue-full-is-busy',
    steps: [
      ...FILL_INTERACTIVE,
      { read: 'q', key: D, task: 'query', count: 32 },
      { read: 'overflow', key: D, task: 'summary' },
      { read: 'other-class', key: E, task: 'detect-changed' },
      { shutdown: true },
    ],
  },
  {
    name: 'comparison-queue-full-is-busy',
    steps: [
      { read: 'c0', key: A, task: 'detect-changed' },
      { read: 'c', key: B, task: 'change-impact', count: 8 },
      { read: 'overflow', key: C, task: 'detect-changed' },
      { read: 'interactive', key: D, task: 'query' },
      { shutdown: true },
    ],
  },
  {
    name: 'maintenance-queue-full-is-busy',
    steps: [
      { read: 'm0', key: A, task: 'fingerprint-metadata' },
      { read: 'm', key: B, task: 'validate-base', count: 32 },
      { read: 'overflow', key: C, task: 'base-identity' },
      { shutdown: true },
    ],
  },
  {
    name: 'interactive-queue-timeout',
    steps: [
      ...FILL_INTERACTIVE,
      { read: 'waiting', key: D, task: 'query' },
      { advance: 4_999 },
      { advance: 1 },
      { reply: 'i1', with: 'ok' },
      { shutdown: true },
    ],
  },
  {
    name: 'comparison-and-maintenance-queue-timeouts',
    steps: [
      { read: 'c0', key: A, task: 'detect-changed' },
      { read: 'c1', key: B, task: 'detect-changed' },
      { read: 'm0', key: C, task: 'persist-fingerprint' },
      { read: 'm1', key: D, task: 'validate-base' },
      { advance: 29_999 },
      { advance: 1 },
      { shutdown: true },
    ],
  },
  {
    name: 'execution-timeouts',
    steps: [
      { read: 'query', key: A, task: 'query' },
      { read: 'impact', key: B, task: 'change-impact' },
      { advance: 29_999 },
      { advance: 1 },
      { advance: 270_000 },
      { advance: 1 },
    ],
  },
  {
    // Every process slot is busy while the interactive class still has room.
    name: 'aged-comparison-takes-one-turn',
    steps: [
      { read: 'i1', key: A, task: 'query' },
      { read: 'i2', key: B, task: 'query' },
      { read: 'c1', key: C, task: 'detect-changed' },
      { read: 'm1', key: D, task: 'fingerprint-metadata' },
      { read: 'c2', key: E, task: 'detect-changed' },
      { read: 'c3', key: F, task: 'change-impact' },
      { advance: 15_000 },
      { read: 'late', key: 'project/g', task: 'query' },
      { reply: 'c1', with: 'ok' },
      { reply: 'c2', with: 'ok' },
      { reply: 'late', with: 'ok' },
      { shutdown: true },
    ],
  },
  {
    name: 'aged-maintenance-takes-one-turn',
    steps: [
      { read: 'i1', key: A, task: 'query' },
      { read: 'i2', key: B, task: 'query' },
      { read: 'c1', key: C, task: 'detect-changed' },
      { read: 'm1', key: D, task: 'fingerprint-metadata' },
      { read: 'm2', key: E, task: 'validate-base' },
      { read: 'm3', key: F, task: 'base-identity' },
      { advance: 5_000 },
      { read: 'late', key: 'project/g', task: 'summary' },
      { reply: 'm1', with: 'ok' },
      { reply: 'm2', with: 'ok' },
      { reply: 'late', with: 'ok' },
      { shutdown: true },
    ],
  },
  {
    name: 'warm-worker-reuse-and-retirement',
    steps: [
      { read: 'q1', key: A, task: 'query' },
      { reply: 'q1', with: 'ok' },
      { read: 'q2', key: A, task: 'query' },
      { reply: 'q2', with: 'ok' },
      { read: 'impact', key: A, task: 'change-impact' },
      { reply: 'impact', with: 'ok' },
      { read: 'summary', key: B, task: 'summary' },
      { reply: 'summary', with: 'ok' },
      { read: 'q3', key: A, task: 'query' },
      { reply: 'q3', with: 'ok' },
      { advance: 180_000 },
    ],
  },
  {
    name: 'cold-key-evicts-least-recent-idle-worker',
    steps: [
      { read: 'a', key: A, task: 'query' },
      { reply: 'a', with: 'ok' },
      { read: 'b', key: B, task: 'query' },
      { reply: 'b', with: 'ok' },
      { read: 'c', key: C, task: 'query' },
      { reply: 'c', with: 'ok' },
      { read: 'd', key: D, task: 'query' },
      { reply: 'd', with: 'ok' },
      { read: 'e', key: E, task: 'query' },
      { reply: 'e', with: 'ok' },
      { read: 'a-again', key: A, task: 'query' },
      { reply: 'a-again', with: 'ok' },
      { shutdown: true },
    ],
  },
  {
    name: 'worker-failures',
    steps: [
      { read: 'crash', key: A, task: 'query' },
      { crash: 'crash' },
      { read: 'malformed', key: B, task: 'query' },
      { reply: 'malformed', with: 'malformed' },
      { read: 'busy', key: C, task: 'query' },
      { reply: 'busy', with: 'failure-busy' },
      { read: 'summary-busy', key: D, task: 'summary' },
      { reply: 'summary-busy', with: 'summary-busy' },
      { shutdown: true },
    ],
  },
  {
    name: 'cancellation-and-fences',
    steps: [
      ...FILL_INTERACTIVE,
      { read: 'queued-a', key: A, task: 'query' },
      { read: 'queued-d', key: D, task: 'query' },
      { cancelKey: A },
      { fenceKey: B },
      { read: 'fenced-b', key: B, task: 'query' },
      { releaseFence: B },
      { read: 'released-b', key: B, task: 'query' },
      { cancelProject: 'project' },
      { read: 'after-cancel', key: E, task: 'query' },
      { reply: 'after-cancel', with: 'ok' },
      { shutdown: true },
      { read: 'after-shutdown', key: F, task: 'query' },
    ],
  },
];
