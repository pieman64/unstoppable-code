// Per-phase canary evaluation with explicit handling of empty phases and
// fixtures that were not live in the positive control. `evaluate` is injected
// (shared/capture.mjs evaluateCanary in run.mjs) so this module stays pure.
import { classifyRecordsByPhase, recordsInPhase } from './anthropic-bytes.mjs';

export const STATUS_RANK = Object.freeze({
  fail: 4,
  blocked: 3,
  unobserved: 2,
  pass: 1,
});

/** Worst-of aggregate over statuses (fail > blocked > unobserved > pass). */
export function worstStatus(statuses) {
  let worst = null;
  for (const status of statuses)
    if (
      worst === null ||
      (STATUS_RANK[status] ?? 0) > (STATUS_RANK[worst] ?? 0)
    )
      worst = status;
  return worst ?? 'unobserved';
}

/**
 * Evaluate one canary token in one phase of one snapshot.
 *
 * - no record in the phase: `unobserved` (an empty search proves nothing)
 * - absent and the fixture was not live in the control: `blocked`
 */
export function evaluatePhase({
  snapshot,
  phases,
  phase,
  token,
  expected,
  evaluate,
  live,
}) {
  const records = recordsInPhase(snapshot.records, phases, phase);
  if (records.length === 0)
    return {
      status: 'unobserved',
      detail: 'no outbound records in this phase',
      hits: 0,
      searched: 0,
    };
  const result = evaluate(
    snapshot,
    token,
    expected,
    (record) => phases.get(record.seq) === phase,
  );
  let { status } = result;
  let detail = result.detail;
  if (
    status === 'pass' &&
    expected === 'absent' &&
    live &&
    live.live === false
  ) {
    status = 'blocked';
    detail = `absent, but the fixture was not live in the positive control (${live.basis}); absence is not evidence`;
  }
  return {
    status,
    detail,
    hits: result.hits.length,
    searched: records.length,
    hitSeqs: result.hits.map((hit) => hit.seq),
  };
}

/**
 * Evaluate every canary over every phase of one snapshot.
 *
 * @returns {{ phases: Map<number,string>, results: Record<string, Record<string, object>> }}
 */
export function evaluateAllCanaries({
  snapshot,
  catalog,
  tokens,
  phaseNames,
  evaluate,
  liveness,
  resultSeq = null,
  forcePhase = null,
}) {
  const phases = forcePhase
    ? new Map(snapshot.records.map((record) => [record.seq, forcePhase]))
    : classifyRecordsByPhase(snapshot.records, { resultSeq });
  const results = {};
  for (const entry of catalog) {
    results[entry.id] = {};
    for (const phase of phaseNames) {
      results[entry.id][phase] = evaluatePhase({
        snapshot,
        phases,
        phase,
        token: tokens[entry.id],
        expected: entry.expected,
        evaluate,
        live: liveness?.[entry.id],
      });
    }
  }
  return { phases, results };
}

/** Merge per-variant results into one (canary, phase) status with evidence per variant. */
export function aggregateVariants(variantResults, canaryId, phase) {
  const entries = Object.entries(variantResults)
    .map(([variant, results]) => [variant, results?.[canaryId]?.[phase]])
    .filter(([, result]) => result);
  const nonEmpty = entries.filter(
    ([, result]) => result.status !== 'unobserved',
  );
  // A variant with no records in a phase says nothing about it; only variants
  // that sent something in the phase decide the aggregate.
  const status =
    nonEmpty.length > 0
      ? worstStatus(nonEmpty.map(([, result]) => result.status))
      : 'unobserved';
  return {
    status,
    evidence: Object.fromEntries(
      entries.map(([variant, result]) => [
        variant,
        {
          status: result.status,
          detail: result.detail,
          hits: result.hits,
          searched: result.searched,
        },
      ]),
    ),
    variantsWithRecords: nonEmpty.length,
  };
}
