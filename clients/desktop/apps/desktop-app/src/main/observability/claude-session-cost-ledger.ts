import type {
  AgentAuditCostDerivation,
  AgentAuditModelUsage,
} from '@canopy/desktop-shared/types';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomically } from '../lib/atomic-file';
import { getAgentObservabilityAuditDir } from '../lib/paths';

export interface ClaudeModelUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUsd: number;
  costBasis?: 'list' | 'managed' | 'unknown';
}

export interface ClaudeRunningTotals {
  totalCostUsd: number;
  modelUsage: Readonly<Record<string, ClaudeModelUsageTotals>>;
}

export interface ClaudeMainLoopUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ClaudeResultInput {
  sessionId: string;
  totals: ClaudeRunningTotals;
  mainLoopUsage: ClaudeMainLoopUsage;
  mainModel?: string;
}

export interface ClaudeResultCost {
  costUsd: number;
  modelUsage: AgentAuditModelUsage[];
  derivation: AgentAuditCostDerivation;
  cumulativeCostUsd: number;
}

interface SessionRow {
  totals: ClaudeRunningTotals;
  updatedAt: number;
}

interface QueryState {
  startedFrom?: { sessionId: string; fork: boolean };
  /** The parent's totals when the fork began; the parent can advance later. */
  forkBaseline?: ClaudeRunningTotals;
  pendingReset: boolean;
  lastSessionId?: string;
}

interface PersistedLedger {
  version: 1;
  sessions: Record<string, SessionRow>;
}

const ZERO_TOTALS: ClaudeRunningTotals = {
  totalCostUsd: 0,
  modelUsage: {},
};
const INPUT_WEIGHT = 1;
const OUTPUT_WEIGHT = 5;
const CACHE_READ_WEIGHT = 0.1;
const CACHE_CREATION_WEIGHT = 1.25;
const DEFAULT_MAX_SESSIONS = 4096;
const DEFAULT_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;
const DEFAULT_PERSIST_DELAY_MS = 2000;
const COST_TOLERANCE = 1e-9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCostBasis(
  value: unknown,
): value is NonNullable<ClaudeModelUsageTotals['costBasis']> {
  return value === 'list' || value === 'managed' || value === 'unknown';
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function numberOrZero(value: unknown): number {
  return nonNegativeFiniteNumber(value) ?? 0;
}

function ownModelUsage(
  modelUsage: Readonly<Record<string, ClaudeModelUsageTotals>>,
  model: string,
): ClaudeModelUsageTotals | undefined {
  return Object.prototype.hasOwnProperty.call(modelUsage, model)
    ? modelUsage[model]
    : undefined;
}

function normalizeModelTotals(
  value: unknown,
): ClaudeModelUsageTotals | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonNegativeFiniteNumber(value.inputTokens);
  const outputTokens = nonNegativeFiniteNumber(value.outputTokens);
  const cacheReadInputTokens = nonNegativeFiniteNumber(
    value.cacheReadInputTokens,
  );
  const cacheCreationInputTokens = nonNegativeFiniteNumber(
    value.cacheCreationInputTokens,
  );
  const webSearchRequests = nonNegativeFiniteNumber(value.webSearchRequests);
  const costUsd = nonNegativeFiniteNumber(value.costUsd);
  const costBasis = value.costBasis;

  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadInputTokens === undefined ||
    cacheCreationInputTokens === undefined ||
    webSearchRequests === undefined ||
    costUsd === undefined ||
    (costBasis !== undefined && !isCostBasis(costBasis))
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    webSearchRequests,
    costUsd,
    ...(costBasis === undefined ? {} : { costBasis }),
  };
}

function normalizeTotals(value: unknown): ClaudeRunningTotals | undefined {
  if (!isRecord(value)) return undefined;
  const totalCostUsd = nonNegativeFiniteNumber(value.totalCostUsd);
  if (totalCostUsd === undefined || !isRecord(value.modelUsage)) {
    return undefined;
  }

  const modelEntries: [string, ClaudeModelUsageTotals][] = [];
  for (const [model, candidate] of Object.entries(value.modelUsage)) {
    if (!model) return undefined;
    const modelTotals = normalizeModelTotals(candidate);
    if (modelTotals === undefined) return undefined;
    modelEntries.push([model, modelTotals]);
  }

  return {
    totalCostUsd,
    modelUsage: Object.fromEntries(modelEntries),
  };
}

function sdkModelTotals(value: unknown): ClaudeModelUsageTotals | undefined {
  if (!isRecord(value)) return undefined;
  const costBasis = value.costBasis;
  return {
    inputTokens: numberOrZero(value.inputTokens),
    outputTokens: numberOrZero(value.outputTokens),
    cacheReadInputTokens: numberOrZero(value.cacheReadInputTokens),
    cacheCreationInputTokens: numberOrZero(value.cacheCreationInputTokens),
    webSearchRequests: numberOrZero(value.webSearchRequests),
    costUsd: numberOrZero(value.costUSD),
    ...(isCostBasis(costBasis) ? { costBasis } : {}),
  };
}

/**
 * Reads `total_cost_usd` and SDK `modelUsage` fields. An invalid total means
 * that this result does not carry usable running cost totals.
 */
export function readClaudeRunningTotals(
  result: Record<string, unknown>,
): ClaudeRunningTotals | undefined {
  const totalCostUsd = nonNegativeFiniteNumber(result.total_cost_usd);
  if (totalCostUsd === undefined) return undefined;

  const modelUsage: [string, ClaudeModelUsageTotals][] = [];
  if (isRecord(result.modelUsage)) {
    for (const [model, value] of Object.entries(result.modelUsage)) {
      const modelTotals = sdkModelTotals(value);
      if (model && modelTotals !== undefined) {
        modelUsage.push([model, modelTotals]);
      }
    }
  }

  return { totalCostUsd, modelUsage: Object.fromEntries(modelUsage) };
}

/** Reads SDK `usage` token counts, treating absent or invalid counts as zero. */
export function readClaudeMainLoopUsage(
  result: Record<string, unknown>,
): ClaudeMainLoopUsage {
  const usage = isRecord(result.usage) ? result.usage : {};
  return {
    inputTokens: numberOrZero(usage.input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
    cacheReadInputTokens: numberOrZero(usage.cache_read_input_tokens),
    cacheCreationInputTokens: numberOrZero(usage.cache_creation_input_tokens),
  };
}

function weightedUsage(usage: ClaudeMainLoopUsage): number {
  return (
    usage.inputTokens * INPUT_WEIGHT +
    usage.outputTokens * OUTPUT_WEIGHT +
    usage.cacheReadInputTokens * CACHE_READ_WEIGHT +
    usage.cacheCreationInputTokens * CACHE_CREATION_WEIGHT
  );
}

function weightedModelTotals(totals: ClaudeModelUsageTotals): number {
  return (
    totals.inputTokens * INPUT_WEIGHT +
    totals.outputTokens * OUTPUT_WEIGHT +
    totals.cacheReadInputTokens * CACHE_READ_WEIGHT +
    totals.cacheCreationInputTokens * CACHE_CREATION_WEIGHT
  );
}

function delta(current: number, baseline: number): number {
  const difference = Math.max(0, current - baseline);
  return Number(difference.toFixed(12));
}

function modelUsageDelta(
  current: ClaudeRunningTotals,
  baseline: ClaudeRunningTotals,
): AgentAuditModelUsage[] {
  const rows: AgentAuditModelUsage[] = [];
  for (const [model, currentModel] of Object.entries(current.modelUsage)) {
    const previousModel = ownModelUsage(baseline.modelUsage, model);
    const inputTokens = delta(
      currentModel.inputTokens,
      previousModel?.inputTokens ?? 0,
    );
    const outputTokens = delta(
      currentModel.outputTokens,
      previousModel?.outputTokens ?? 0,
    );
    const cacheReadInputTokens = delta(
      currentModel.cacheReadInputTokens,
      previousModel?.cacheReadInputTokens ?? 0,
    );
    const cacheCreationInputTokens = delta(
      currentModel.cacheCreationInputTokens,
      previousModel?.cacheCreationInputTokens ?? 0,
    );
    const webSearchRequests = delta(
      currentModel.webSearchRequests,
      previousModel?.webSearchRequests ?? 0,
    );
    const costUsd = delta(currentModel.costUsd, previousModel?.costUsd ?? 0);

    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      cacheReadInputTokens === 0 &&
      cacheCreationInputTokens === 0 &&
      webSearchRequests === 0 &&
      costUsd === 0
    ) {
      continue;
    }

    rows.push({
      model,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      ...(webSearchRequests === 0 ? {} : { webSearchRequests }),
      costUsd,
      ...(currentModel.costBasis === undefined
        ? {}
        : { costBasis: currentModel.costBasis }),
    });
  }
  return rows;
}

function isZeroed(totals: ClaudeRunningTotals): boolean {
  return (
    totals.totalCostUsd === 0 &&
    Object.values(totals.modelUsage).every((model) => model.costUsd === 0)
  );
}

function normalizeInputTotals(
  totals: ClaudeRunningTotals,
): ClaudeRunningTotals {
  return (
    normalizeTotals(totals) ?? {
      totalCostUsd: numberOrZero(totals.totalCostUsd),
      modelUsage: {},
    }
  );
}

function normalizeMainLoopUsage(
  usage: ClaudeMainLoopUsage,
): ClaudeMainLoopUsage {
  return {
    inputTokens: numberOrZero(usage.inputTokens),
    outputTokens: numberOrZero(usage.outputTokens),
    cacheReadInputTokens: numberOrZero(usage.cacheReadInputTokens),
    cacheCreationInputTokens: numberOrZero(usage.cacheCreationInputTokens),
  };
}

function chooseEstimateModel(
  totals: ClaudeRunningTotals,
  mainModel: string | undefined,
): [string, ClaudeModelUsageTotals] | undefined {
  if (mainModel !== undefined) {
    const selected = ownModelUsage(totals.modelUsage, mainModel);
    if (selected !== undefined) return [mainModel, selected];
  }

  let largest: [string, ClaudeModelUsageTotals] | undefined;
  for (const entry of Object.entries(totals.modelUsage)) {
    if (largest === undefined || entry[1].costUsd > largest[1].costUsd) {
      largest = entry;
    }
  }
  return largest;
}

function estimateResult(
  input: ClaudeResultInput,
  totals: ClaudeRunningTotals,
  baselineRow: SessionRow | undefined,
): ClaudeResultCost {
  const selected = chooseEstimateModel(totals, input.mainModel);
  if (selected === undefined) {
    return {
      costUsd: 0,
      modelUsage: [],
      derivation: 'estimated_unknown_baseline',
      cumulativeCostUsd: totals.totalCostUsd,
    };
  }

  const [model, currentModel] = selected;
  const priorModel =
    baselineRow === undefined
      ? undefined
      : ownModelUsage(baselineRow.totals.modelUsage, model);
  const priorWeightedTokens =
    priorModel === undefined ? 0 : weightedModelTotals(priorModel);
  const currentWeightedTokens = weightedModelTotals(currentModel);
  let rateSource = currentModel;
  let rateTokens = currentWeightedTokens;
  if (
    priorModel !== undefined &&
    priorWeightedTokens > 0 &&
    Number.isFinite(priorWeightedTokens)
  ) {
    rateSource = priorModel;
    rateTokens = priorWeightedTokens;
  }
  if (rateTokens <= 0 || !Number.isFinite(rateTokens)) {
    return {
      costUsd: 0,
      modelUsage: [],
      derivation: 'estimated_unknown_baseline',
      cumulativeCostUsd: totals.totalCostUsd,
    };
  }

  const rate = rateSource.costUsd / rateTokens;
  if (!Number.isFinite(rate) || rate < 0) {
    return {
      costUsd: 0,
      modelUsage: [],
      derivation: 'estimated_unknown_baseline',
      cumulativeCostUsd: totals.totalCostUsd,
    };
  }

  const mainLoopUsage = normalizeMainLoopUsage(input.mainLoopUsage);
  const estimated = weightedUsage(mainLoopUsage) * rate;
  const costUsd = Math.min(
    totals.totalCostUsd,
    Number.isFinite(estimated) ? Math.max(0, estimated) : totals.totalCostUsd,
  );
  return {
    costUsd,
    modelUsage: [
      {
        model,
        inputTokens: mainLoopUsage.inputTokens,
        outputTokens: mainLoopUsage.outputTokens,
        cacheReadInputTokens: mainLoopUsage.cacheReadInputTokens,
        cacheCreationInputTokens: mainLoopUsage.cacheCreationInputTokens,
        costUsd,
        ...(currentModel.costBasis === undefined
          ? {}
          : { costBasis: currentModel.costBasis }),
      },
    ],
    derivation: 'estimated_unknown_baseline',
    cumulativeCostUsd: totals.totalCostUsd,
  };
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Holds the last known Claude SDK running totals for each native session.
 * Query state is intentionally process-local; session totals survive restart.
 */
export class ClaudeSessionCostLedger {
  private readonly rows = new Map<string, SessionRow>();
  private readonly queries = new Map<string, QueryState>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxAgeMs: number;
  private readonly persistDelayMs: number;
  private mutationVersion = 0;
  private persistedVersion = 0;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;

  constructor(options: {
    filePath: string;
    now?: () => number;
    maxSessions?: number;
    maxAgeMs?: number;
    persistDelayMs?: number;
  }) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.maxSessions = normalizedLimit(
      options.maxSessions,
      DEFAULT_MAX_SESSIONS,
    );
    this.maxAgeMs = normalizedLimit(options.maxAgeMs, DEFAULT_MAX_AGE_MS);
    this.persistDelayMs = normalizedLimit(
      options.persistDelayMs,
      DEFAULT_PERSIST_DELAY_MS,
    );
  }

  private readonly filePath: string;
  private loadPromise: Promise<void> | undefined;

  /**
   * Loads once; repeated calls share the first load. Missing or malformed
   * data is treated as an empty ledger. Rows recorded before the load
   * finishes are kept when newer than the stored ones.
   */
  load(): Promise<void> {
    this.loadPromise ??= this.loadFromDisk();
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      return;
    }

    const loadedRows = new Map<string, SessionRow>();
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.sessions)) {
      for (const [sessionId, value] of Object.entries(parsed.sessions)) {
        if (!sessionId || !isRecord(value)) continue;
        const updatedAt = nonNegativeFiniteNumber(value.updatedAt);
        const totals = normalizeTotals(value.totals);
        if (updatedAt === undefined || totals === undefined) continue;
        loadedRows.set(sessionId, { totals, updatedAt });
      }
    }

    loadedRows.forEach((row, sessionId) => {
      const current = this.rows.get(sessionId);
      if (current === undefined || current.updatedAt < row.updatedAt) {
        this.rows.set(sessionId, row);
      }
    });
    const previousSize = this.rows.size;
    this.pruneRows(this.currentTime());
    if (this.rows.size !== previousSize) {
      this.markDirty();
    }
  }

  beginQuery(
    queryId: string,
    startedFrom?: { sessionId: string; fork: boolean },
  ): void {
    const forkBaseline =
      startedFrom?.fork === true
        ? this.rows.get(startedFrom.sessionId)?.totals
        : undefined;
    this.queries.set(queryId, {
      ...(startedFrom === undefined ? {} : { startedFrom }),
      ...(forkBaseline === undefined ? {} : { forkBaseline }),
      pendingReset: false,
    });
  }

  noteConversationReset(queryId: string): void {
    const state = this.queryFor(queryId);
    state.pendingReset = true;
  }

  endQuery(queryId: string): void {
    this.queries.delete(queryId);
  }

  recordResult(queryId: string, input: ClaudeResultInput): ClaudeResultCost {
    const totals = normalizeInputTotals(input.totals);
    const existingRow = this.rows.get(input.sessionId);
    if (isZeroed(totals)) {
      return {
        costUsd: 0,
        modelUsage: [],
        derivation: 'exact',
        cumulativeCostUsd: existingRow?.totals.totalCostUsd ?? 0,
      };
    }

    const query = this.queryFor(queryId);
    const currentInput: ClaudeResultInput = {
      ...input,
      totals,
      mainLoopUsage: normalizeMainLoopUsage(input.mainLoopUsage),
    };

    let baseline: ClaudeRunningTotals | undefined;
    let baselineRow: SessionRow | undefined;
    if (query.pendingReset) {
      baseline = ZERO_TOTALS;
      query.pendingReset = false;
    } else if (existingRow !== undefined) {
      if (
        totals.totalCostUsd + COST_TOLERANCE >=
        existingRow.totals.totalCostUsd
      ) {
        baseline = existingRow.totals;
      }
    } else if (
      query.lastSessionId !== undefined &&
      query.lastSessionId !== input.sessionId
    ) {
      const previousRow = this.rows.get(query.lastSessionId);
      if (
        previousRow !== undefined &&
        previousRow.totals.totalCostUsd <= totals.totalCostUsd
      ) {
        baseline = previousRow.totals;
      }
    } else if (query.startedFrom?.fork === true) {
      if (
        query.forkBaseline !== undefined &&
        query.forkBaseline.totalCostUsd <= totals.totalCostUsd
      ) {
        baseline = query.forkBaseline;
      }
    } else if (query.startedFrom !== undefined) {
      // A resumed query with no stored session baseline is uncertain.
      baselineRow = existingRow;
    } else {
      baseline = ZERO_TOTALS;
    }

    const result: ClaudeResultCost =
      baseline === undefined
        ? estimateResult(currentInput, totals, baselineRow ?? existingRow)
        : {
            costUsd: Math.min(
              totals.totalCostUsd,
              delta(totals.totalCostUsd, baseline.totalCostUsd),
            ),
            modelUsage: modelUsageDelta(totals, baseline),
            derivation: 'exact',
            cumulativeCostUsd: totals.totalCostUsd,
          };

    const updatedAt = this.currentTime();
    this.rows.delete(input.sessionId);
    this.rows.set(input.sessionId, { totals, updatedAt });
    query.lastSessionId = input.sessionId;
    this.pruneRows(updatedAt);
    this.markDirty();
    return result;
  }

  /** Writes pending state immediately. */
  flush(): Promise<void> {
    this.clearPersistTimer();
    if (this.flushPromise !== undefined) return this.flushPromise;
    const flushPromise = this.writePending().finally(() => {
      this.clearPersistTimer();
      if (this.flushPromise === flushPromise) this.flushPromise = undefined;
    });
    this.flushPromise = flushPromise;
    return flushPromise;
  }

  private queryFor(queryId: string): QueryState {
    const existing = this.queries.get(queryId);
    if (existing !== undefined) return existing;
    const fresh: QueryState = { pendingReset: false };
    this.queries.set(queryId, fresh);
    return fresh;
  }

  private currentTime(): number {
    const timestamp = nonNegativeFiniteNumber(this.now());
    return timestamp ?? Date.now();
  }

  private pruneRows(now: number): void {
    const oldest = now - this.maxAgeMs;
    this.rows.forEach((row, sessionId) => {
      if (row.updatedAt < oldest) this.rows.delete(sessionId);
    });

    if (this.rows.size <= this.maxSessions) return;
    const newestFirst = Array.from(this.rows.entries()).map(
      ([sessionId, row], insertionOrder) => ({
        sessionId,
        row,
        insertionOrder,
      }),
    );
    newestFirst.sort(
      (left, right) =>
        right.row.updatedAt - left.row.updatedAt ||
        right.insertionOrder - left.insertionOrder,
    );
    const retained = new Set(
      newestFirst.slice(0, this.maxSessions).map((entry) => entry.sessionId),
    );
    this.rows.forEach((_row, sessionId) => {
      if (!retained.has(sessionId)) this.rows.delete(sessionId);
    });
  }

  private markDirty(): void {
    this.mutationVersion += 1;
    this.clearPersistTimer();
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush().catch(() => undefined);
    }, this.persistDelayMs);
  }

  private clearPersistTimer(): void {
    if (this.persistTimer === undefined) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
  }

  private async writePending(): Promise<void> {
    // Never overwrite the stored ledger before it has been read.
    await this.load();
    while (this.persistedVersion < this.mutationVersion) {
      this.pruneRows(this.currentTime());
      const version = this.mutationVersion;
      const sessions: [string, SessionRow][] = Array.from(
        this.rows.entries(),
      ).map(([sessionId, row]) => [sessionId, row]);
      const payload: PersistedLedger = {
        version: 1,
        sessions: Object.fromEntries(sessions),
      };
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFileAtomically(this.filePath, `${JSON.stringify(payload)}\n`);
      this.persistedVersion = version;
    }
  }
}

let singleton: ClaudeSessionCostLedger | undefined;

/** Main-process singleton persisted in the agent observability root directory. */
export function getClaudeSessionCostLedger(): ClaudeSessionCostLedger {
  if (singleton === undefined) {
    const filePath = join(
      dirname(getAgentObservabilityAuditDir()),
      'claude-session-costs.json',
    );
    singleton = new ClaudeSessionCostLedger({ filePath });
    void singleton.load().catch(() => undefined);
  }
  return singleton;
}
