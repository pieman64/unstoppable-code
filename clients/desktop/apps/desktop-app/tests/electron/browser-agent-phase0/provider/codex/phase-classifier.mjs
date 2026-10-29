// Phase classification of captured records within one turn window.
//
// Phases follow the plan: the first model request is `before-inference`, later
// generation requests (which carry tool results) are `after-tools`, and any
// record that arrives after the turn completed is `completion`. Non-generation
// records (GET /v1/models, prewarms, unrouted paths) are NOT dropped: they
// take the phase of their position, so every channel is searched.
import { isGenerationRecord } from './request-breakdown.mjs';

export const WINDOW_PHASES = Object.freeze([
  'before-inference',
  'after-tools',
  'completion',
]);

/**
 * @param {{ seq: number }[]} records in seq order
 * @param {{ completionSeq?: number | null, singlePhase?: string }} options
 *   `completionSeq`: highest seq observed when the turn outcome resolved;
 *   later records are `completion`. `singlePhase` labels the whole window
 *   (used for the induced launch-failure window).
 * @returns {Map<number, string>} seq -> phase
 */
export function classifyRecords(
  records,
  { completionSeq = null, singlePhase } = {},
) {
  const phases = new Map();
  let seenGeneration = false;
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    if (singlePhase) {
      phases.set(record.seq, singlePhase);
      continue;
    }
    if (completionSeq !== null && record.seq > completionSeq) {
      phases.set(record.seq, 'completion');
      continue;
    }
    if (isGenerationRecord(record)) {
      phases.set(
        record.seq,
        seenGeneration ? 'after-tools' : 'before-inference',
      );
      seenGeneration = true;
    } else {
      phases.set(
        record.seq,
        seenGeneration ? 'after-tools' : 'before-inference',
      );
    }
  }
  return phases;
}

const ORDER = ['fail', 'blocked', 'unobserved', 'measured', 'pass'];

/** Worst-of aggregation of statuses (fail > blocked > unobserved > measured > pass). */
export function aggregateStatuses(statuses) {
  if (statuses.length === 0) return 'unobserved';
  for (const status of ORDER) if (statuses.includes(status)) return status;
  return statuses[0];
}

/**
 * Evaluate one canary across windows for one phase. `evaluate` is injected
 * (shared evaluateCanary in production): `(snapshot, filter) -> {status, hits, detail}`.
 * A window with no records in the phase is skipped; with no searchable window
 * at all the result is `unobserved`, never a vacuous pass.
 *
 * @param {{ label: string, snapshot: object, phases: Map<number,string> }[]} windows
 */
export function evaluateAcrossWindows(windows, phase, evaluate) {
  const perWindow = [];
  for (const window of windows) {
    const inPhase = window.snapshot.records.filter(
      (record) => window.phases.get(record.seq) === phase,
    );
    if (inPhase.length === 0) {
      perWindow.push({
        window: window.label,
        status: 'skipped',
        detail: 'no records in this phase',
      });
      continue;
    }
    const result = evaluate(
      window.snapshot,
      (record) => window.phases.get(record.seq) === phase,
    );
    perWindow.push({
      window: window.label,
      records: inPhase.length,
      status: result.status,
      detail: result.detail,
      hits: result.hits.map((hit) => ({
        seq: hit.seq,
        locations: hit.locations,
        prompt: hit.prompt,
      })),
    });
  }
  const searched = perWindow.filter((entry) => entry.status !== 'skipped');
  return {
    status:
      searched.length === 0
        ? 'unobserved'
        : aggregateStatuses(searched.map((entry) => entry.status)),
    perWindow,
  };
}
