import type {
  DelegateSettledStatus,
  DelegationStopReason,
} from '@canopy/protocol/delegation';
import type { LegacyDelegationPrefix, StoredDelegationV3 } from './record-v3';
import type {
  StoredDelegation,
  StoredDelegationLegacy,
  StoredDelegateOutput,
} from './broker';

/** Enumerable on purpose: object spreads must not erase the storage guard. */
export const TERMINAL_DELEGATION_SUMMARY_TAG =
  '__canopyTerminalDelegationSummary' as const;

export interface TerminalDelegationResultMetadata {
  readonly resultIndex: number;
  readonly runGeneration: number;
  readonly status: DelegateSettledStatus;
  readonly settledAt: number;
  readonly stopReason?: DelegationStopReason;
}

export interface TerminalDelegationHistoricalStopReason {
  readonly runGeneration: number;
  readonly stopReason: DelegationStopReason;
}

/** Metadata needed by synchronous broker projections after body eviction. */
export interface TerminalDelegationSummaryIndex {
  readonly historyCount: number;
  readonly firstHistoricalTimestamp: number;
  readonly firstHistoricalOrigin?: StoredDelegationV3['registration']['origin'];
  readonly resultMetadata: readonly TerminalDelegationResultMetadata[];
  /** Only frozen legacy results may bypass the canonical stream resolver. */
  readonly legacyResultGenerations: readonly number[];
  readonly historicalStopReasons: readonly TerminalDelegationHistoricalStopReason[];
  readonly stateSequence: number;
  readonly transcriptRevision?: number;
}

type SummaryState = Omit<StoredDelegationLegacy['state'], 'transcript'>;
type SummaryLegacy = Omit<
  StoredDelegationLegacy,
  'history' | 'results' | 'state'
> & { readonly state: SummaryState };
type SummaryLegacyPrefix = Omit<LegacyDelegationPrefix, 'history' | 'results'>;
type SummaryV3 = Omit<StoredDelegationV3, 'legacyPrefix'> & {
  readonly legacyPrefix?: SummaryLegacyPrefix;
};

/**
 * An in-memory, tagged view of a terminal StoredDelegation. It intentionally
 * remains structurally assignable to StoredDelegation so metadata-only broker
 * projections do not need a parallel record API.
 */
export type TerminalDelegationSummary = (SummaryLegacy | SummaryV3) & {
  readonly [TERMINAL_DELEGATION_SUMMARY_TAG]: true;
  readonly summaryIndex: TerminalDelegationSummaryIndex;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameHistoricalOrigin(
  left: TerminalDelegationSummaryIndex['firstHistoricalOrigin'],
  right: TerminalDelegationSummaryIndex['firstHistoricalOrigin'],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.kind === right.kind &&
    left.anchorMessageId === right.anchorMessageId &&
    left.authoredItemId === right.authoredItemId
  );
}

function isSettledStatus(
  status: StoredDelegateOutput['status'] | StoredDelegation['state']['status'],
): status is DelegateSettledStatus {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'deadline_exceeded' ||
    status === 'interrupted'
  );
}

function resultMetadata(
  entry: StoredDelegateOutput,
): TerminalDelegationResultMetadata {
  return {
    resultIndex: entry.resultIndex,
    runGeneration: entry.runGeneration,
    status: entry.status,
    settledAt: entry.settledAt,
    ...(entry.stopReason === undefined ? {} : { stopReason: entry.stopReason }),
  };
}

function summaryIndexFor(
  record: StoredDelegation,
): TerminalDelegationSummaryIndex {
  const history =
    record.version === 3
      ? (record.legacyPrefix?.history ?? [])
      : (record.history ?? []);
  const storedResults =
    record.version === 3
      ? (record.legacyPrefix?.results ?? [])
      : (record.results ?? []);
  const historicalStopReasons = new Map<number, DelegationStopReason>();
  for (const transcript of history) {
    const stopReason = transcript.snapshot.stopReason;
    if (
      stopReason !== undefined &&
      !historicalStopReasons.has(transcript.runGeneration)
    )
      historicalStopReasons.set(transcript.runGeneration, stopReason);
  }
  const fallbackStopReason = (
    runGeneration: number,
  ): DelegationStopReason | undefined =>
    runGeneration === record.state.runGeneration &&
    isSettledStatus(record.state.status)
      ? record.state.stopReason
      : historicalStopReasons.get(runGeneration);
  const metadata = new Map<number, TerminalDelegationResultMetadata>();
  for (const entry of storedResults) {
    const summary = resultMetadata(entry);
    metadata.set(entry.runGeneration, {
      ...summary,
      ...(summary.stopReason === undefined
        ? ((): { readonly stopReason?: DelegationStopReason } => {
            const stopReason = fallbackStopReason(entry.runGeneration);
            return stopReason === undefined ? {} : { stopReason };
          })()
        : {}),
    });
  }
  for (const transcript of history) {
    if (!isSettledStatus(transcript.snapshot.status)) continue;
    if (metadata.has(transcript.runGeneration)) continue;
    const resultIndex = transcript.snapshot.resultIndex ?? metadata.size + 1;
    metadata.set(transcript.runGeneration, {
      resultIndex,
      runGeneration: transcript.runGeneration,
      status: transcript.snapshot.status,
      settledAt: transcript.createdAt,
      ...(transcript.snapshot.stopReason === undefined
        ? {}
        : { stopReason: transcript.snapshot.stopReason }),
    });
  }
  if (record.version === 3 && record.latestResult)
    metadata.set(record.latestResult.runGeneration, {
      resultIndex: record.latestResult.resultIndex,
      runGeneration: record.latestResult.runGeneration,
      status: record.latestResult.status,
      settledAt: record.latestResult.settledAt,
      ...((record.latestResult.stopReason ??
        fallbackStopReason(record.latestResult.runGeneration)) === undefined
        ? {}
        : {
            stopReason:
              record.latestResult.stopReason ??
              fallbackStopReason(record.latestResult.runGeneration),
          }),
    });
  else if (
    record.version !== 3 &&
    isSettledStatus(record.state.status) &&
    !metadata.has(record.state.runGeneration)
  )
    metadata.set(record.state.runGeneration, {
      resultIndex: metadata.size + 1,
      runGeneration: record.state.runGeneration,
      status: record.state.status,
      settledAt: record.state.finishedAt ?? record.createdAt,
      ...(record.state.stopReason === undefined
        ? {}
        : { stopReason: record.state.stopReason }),
    });
  const firstHistoricalTimestamp =
    record.version === 3
      ? record.readMetadata.originAt
      : (history[0]?.createdAt ?? record.createdAt);
  return {
    historyCount: history.length,
    firstHistoricalTimestamp,
    ...(record.version === 3
      ? { firstHistoricalOrigin: record.registration.origin }
      : {}),
    resultMetadata: Array.from(metadata.values()).sort(
      (left, right) => left.resultIndex - right.resultIndex,
    ),
    legacyResultGenerations: storedResults.map((entry) => entry.runGeneration),
    historicalStopReasons: Array.from(
      historicalStopReasons,
      ([runGeneration, stopReason]) => ({ runGeneration, stopReason }),
    ),
    stateSequence: record.state.sequence,
    ...(record.transcriptRevision === undefined
      ? {}
      : { transcriptRevision: record.transcriptRevision }),
  };
}

/** Narrow positive discriminator used by both broker and storage boundaries. */
export function isTerminalDelegationSummary(
  value: unknown,
): value is TerminalDelegationSummary {
  return (
    isRecord(value) &&
    value[TERMINAL_DELEGATION_SUMMARY_TAG] === true &&
    isRecord(value.summaryIndex)
  );
}

/** Remove all retained historical and current transcript/result bodies. */
export function summarizeTerminalDelegation(
  record: StoredDelegation,
): TerminalDelegationSummary {
  if (isTerminalDelegationSummary(record)) return record;
  if (!isSettledStatus(record.state.status))
    throw new Error('Cannot summarize a nonterminal delegation');
  const summaryIndex = summaryIndexFor(record);
  if (record.version === 3) {
    const { legacyPrefix, ...common } = record;
    const {
      history: _history,
      results: _results,
      ...prefix
    } = legacyPrefix ?? {};
    void _history;
    void _results;
    const summary: TerminalDelegationSummary = {
      ...common,
      ...(Object.keys(prefix).length > 0 ? { legacyPrefix: prefix } : {}),
      [TERMINAL_DELEGATION_SUMMARY_TAG]: true,
      summaryIndex,
    };
    return summary;
  }
  const { history: _history, results: _results, state, ...common } = record;
  const { transcript: _transcript, ...bodylessState } = state;
  void _history;
  void _results;
  void _transcript;
  const summary: TerminalDelegationSummary = {
    ...common,
    state: bodylessState,
    [TERMINAL_DELEGATION_SUMMARY_TAG]: true,
    summaryIndex,
  };
  return summary;
}

/** True only when a loaded durable record belongs to this exact summary. */
export function matchesTerminalDelegationSummary(
  summary: TerminalDelegationSummary,
  record: StoredDelegation,
): boolean {
  if (
    isTerminalDelegationSummary(record) ||
    summary.version !== record.version ||
    summary.state.delegationId !== record.state.delegationId ||
    summary.parent.chatId !== record.parent.chatId ||
    summary.parent.projectId !== record.parent.projectId ||
    summary.parent.worktreeId !== record.parent.worktreeId ||
    summary.parent.sessionKey !== record.parent.sessionKey ||
    summary.callKey !== record.callKey ||
    summary.requestHash !== record.requestHash ||
    summary.state.runGeneration !== record.state.runGeneration ||
    summary.state.sequence !== record.state.sequence ||
    summary.state.status !== record.state.status
  )
    return false;

  const expected = summaryIndexFor(record);
  const actual = summary.summaryIndex;
  return (
    actual.stateSequence === expected.stateSequence &&
    actual.transcriptRevision === expected.transcriptRevision &&
    actual.historyCount === expected.historyCount &&
    actual.firstHistoricalTimestamp === expected.firstHistoricalTimestamp &&
    sameHistoricalOrigin(
      actual.firstHistoricalOrigin,
      expected.firstHistoricalOrigin,
    ) &&
    actual.legacyResultGenerations.length ===
      expected.legacyResultGenerations.length &&
    actual.legacyResultGenerations.every(
      (generation, index) =>
        generation === expected.legacyResultGenerations[index],
    ) &&
    actual.resultMetadata.length === expected.resultMetadata.length &&
    actual.resultMetadata.every((entry, index) => {
      const expectedEntry = expected.resultMetadata[index];
      return (
        expectedEntry !== undefined &&
        entry.resultIndex === expectedEntry.resultIndex &&
        entry.runGeneration === expectedEntry.runGeneration &&
        entry.status === expectedEntry.status &&
        entry.settledAt === expectedEntry.settledAt &&
        entry.stopReason === expectedEntry.stopReason
      );
    }) &&
    actual.historicalStopReasons.length ===
      expected.historicalStopReasons.length &&
    actual.historicalStopReasons.every((entry, index) => {
      const expectedEntry = expected.historicalStopReasons[index];
      return (
        expectedEntry !== undefined &&
        entry.runGeneration === expectedEntry.runGeneration &&
        entry.stopReason === expectedEntry.stopReason
      );
    })
  );
}
