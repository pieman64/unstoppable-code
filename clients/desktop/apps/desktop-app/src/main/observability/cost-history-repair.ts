import type {
  AgentAuditEntry,
  AgentAuditModelUsage,
} from '@canopy/desktop-shared/types';
import { codexServiceTierForModelConfig } from '@canopy/desktop-shared/lib/codex-model-config';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { computeCodexObservedCost } from '../openai-pricing/cost-calculator';
import type { OpenAiPricingCacheState } from '../openai-pricing/pricing-client';
import { writeFileAtomically } from '../lib/atomic-file';
import { normalizeAuditEntry } from '@canopy/core-runtime/observability';
import {
  ClaudeSessionCostLedger,
  readClaudeMainLoopUsage,
  readClaudeRunningTotals,
} from './claude-session-cost-ledger';

export interface CostHistoryRepairOptions {
  auditDir: string;
  transcriptIndexDir: string;
  markerPath: string;
  codexPricing: () => OpenAiPricingCacheState;
  append: (entry: AgentAuditEntry) => void | Promise<void>;
  /** Canonical transcript path for entries the index never records. */
  transcriptPathFor?: (entry: AgentAuditEntry) => string | undefined;
  /** Resolves once every appended correction is durably written. */
  commit?: () => Promise<void>;
  isCancelled?: () => boolean;
  yieldEvery?: number;
}

export const COST_HISTORY_REPAIR_VERSION = 1;

export interface CostHistoryRepairResult {
  claudeRepaired: number;
  claudeSkippedNoTranscript: number;
  codexDelegationsPriced: number;
  skipped: boolean;
}

const MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_YIELD_EVERY = 200;
const OVERSIZED_LINE_MARKER = '\u0000cost-history-repair-oversized\u0000';
const CANCELLED_STREAM_MARKER = '\u0000cost-history-repair-cancelled\u0000';
const CLAUDE_REPAIR_EVENT_TYPES = new Set<AgentAuditEntry['eventType']>([
  'worktree_chat',
  'standalone_chat',
  'app_advisor',
  'worktree_plan_chat',
  'pipeline_agent_turn',
  'pipeline_advisor',
]);

type StreamedLine =
  | { readonly kind: 'line'; readonly value: string }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'cancelled' };

interface ClaudeTranscriptCandidate {
  readonly entry: AgentAuditEntry;
  readonly transcriptPath: string;
  readonly sessionId: string;
}

interface ClaudeSessionGroup {
  readonly sessionId: string;
  readonly candidates: ClaudeTranscriptCandidate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function normalizedYieldEvery(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : DEFAULT_YIELD_EVERY;
}

function createCheckpoint(
  options: CostHistoryRepairOptions,
): () => Promise<boolean> {
  const yieldEvery = normalizedYieldEvery(options.yieldEvery);
  let workSinceYield = 0;
  return async (): Promise<boolean> => {
    if (options.isCancelled?.() === true) return true;
    workSinceYield += 1;
    if (workSinceYield >= yieldEvery) {
      workSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return options.isCancelled?.() === true;
    }
    return false;
  };
}

function* splitDecodedText(
  text: string,
  state: { pending: string; pendingBytes: number; oversized: boolean },
): Generator<StreamedLine> {
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    const piece = text.slice(start, end);
    if (!state.oversized) {
      const pieceBytes = Buffer.byteLength(piece, 'utf8');
      if (state.pendingBytes + pieceBytes > MAX_JSONL_LINE_BYTES) {
        state.pending = '';
        state.pendingBytes = 0;
        state.oversized = true;
      } else {
        state.pending += piece;
        state.pendingBytes += pieceBytes;
      }
    }

    if (newline < 0) return;
    if (state.oversized) {
      yield { kind: 'oversized' };
    } else {
      yield { kind: 'line', value: state.pending };
    }
    state.pending = '';
    state.pendingBytes = 0;
    state.oversized = false;
    start = newline + 1;
  }
}

/** Frames bounded lines so readline never has to buffer an oversized line. */
async function* frameJsonlLines(
  path: string,
  checkpoint: () => Promise<boolean>,
): AsyncGenerator<Buffer> {
  const stream = createReadStream(path);
  const decoder = new StringDecoder('utf8');
  const state = { pending: '', pendingBytes: 0, oversized: false };
  const frame = (line: StreamedLine): Buffer => {
    const value =
      line.kind === 'oversized'
        ? OVERSIZED_LINE_MARKER
        : line.kind === 'line'
          ? line.value
          : CANCELLED_STREAM_MARKER;
    return Buffer.from(`${value}\n`, 'utf8');
  };
  try {
    for await (const chunk of stream) {
      if (await checkpoint()) {
        yield frame({ kind: 'cancelled' });
        return;
      }
      if (!Buffer.isBuffer(chunk)) {
        throw new Error('Expected a binary JSONL stream chunk');
      }
      const text = decoder.write(chunk);
      for (const line of Array.from(splitDecodedText(text, state))) {
        if (await checkpoint()) {
          yield frame({ kind: 'cancelled' });
          return;
        }
        yield frame(line);
      }
    }
    const tail = decoder.end();
    for (const line of Array.from(splitDecodedText(tail, state))) {
      if (await checkpoint()) {
        yield frame({ kind: 'cancelled' });
        return;
      }
      yield frame(line);
    }
    if (state.oversized) {
      yield frame({ kind: 'oversized' });
    } else if (state.pending.length > 0) {
      yield frame({ kind: 'line', value: state.pending });
    }
  } finally {
    stream.destroy();
  }
}

/** Reads bounded JSONL lines through readline without retaining whole files. */
async function* streamJsonlLines(
  path: string,
  checkpoint: () => Promise<boolean>,
): AsyncGenerator<StreamedLine> {
  const source = Readable.from(frameJsonlLines(path, checkpoint), {
    objectMode: false,
  });
  const reader = createInterface({ input: source, crlfDelay: Infinity });
  try {
    for await (const value of reader) {
      if (value === OVERSIZED_LINE_MARKER) {
        yield { kind: 'oversized' };
      } else if (value === CANCELLED_STREAM_MARKER) {
        yield { kind: 'cancelled' };
        return;
      } else {
        yield { kind: 'line', value };
      }
    }
  } finally {
    reader.close();
    source.destroy();
  }
}

function parseJsonLine(line: StreamedLine): unknown {
  if (line.kind !== 'line' || line.value.trim().length === 0) return undefined;
  try {
    return JSON.parse(line.value);
  } catch {
    return undefined;
  }
}

function isRepaired(entry: AgentAuditEntry): boolean {
  return (entry.costRepair?.version ?? 0) >= COST_HISTORY_REPAIR_VERSION;
}

function isClaudeRepairEligible(entry: AgentAuditEntry): boolean {
  return (
    entry.provider === 'claude' &&
    entry.status !== 'running' &&
    CLAUDE_REPAIR_EVENT_TYPES.has(entry.eventType) &&
    entry.billingBasis !== 'org_gateway' &&
    entry.billingBasis !== 'local'
  );
}

function isCodexDelegationEligible(entry: AgentAuditEntry): boolean {
  return (
    entry.provider === 'codex' &&
    entry.status !== 'running' &&
    entry.eventType === 'managed_delegation' &&
    typeof entry.model === 'string' &&
    entry.model.length > 0 &&
    entry.totalCostUsd === undefined &&
    entry.observedCost === undefined &&
    entry.billingBasis !== 'org_gateway' &&
    entry.billingBasis !== 'local' &&
    (entry.tokens.input > 0 ||
      entry.tokens.output > 0 ||
      entry.tokens.cacheReadInputTokens > 0 ||
      entry.tokens.cacheCreationInputTokens > 0 ||
      (entry.tokens.reasoningOutputTokens ?? 0) > 0) &&
    !isRepaired(entry)
  );
}

async function listDayFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

async function markerAlreadyComplete(markerPath: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(markerPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return (
    isRecord(value) &&
    typeof value.version === 'number' &&
    Number.isFinite(value.version) &&
    value.version >= COST_HISTORY_REPAIR_VERSION
  );
}

async function readLatestAuditEntries(
  auditDir: string,
  checkpoint: () => Promise<boolean>,
): Promise<{ entries: Map<string, AgentAuditEntry>; cancelled: boolean }> {
  const latestById = new Map<string, AgentAuditEntry>();
  const files = await listDayFiles(auditDir);
  for (const filename of files) {
    if (await checkpoint()) return { entries: latestById, cancelled: true };
    try {
      for await (const line of streamJsonlLines(
        join(auditDir, filename),
        checkpoint,
      )) {
        if (line.kind === 'cancelled') {
          return { entries: latestById, cancelled: true };
        }
        const parsed = parseJsonLine(line);
        if (parsed === undefined) continue;
        const entry = normalizeAuditEntry(parsed);
        if (entry !== null) latestById.set(entry.id, entry);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  return { entries: latestById, cancelled: false };
}

async function readTranscriptIndex(
  directory: string,
  relevantIds: ReadonlySet<string>,
  checkpoint: () => Promise<boolean>,
): Promise<{ paths: Map<string, string>; cancelled: boolean }> {
  const paths = new Map<string, string>();
  const files = await listDayFiles(directory);
  for (const filename of files) {
    if (await checkpoint()) return { paths, cancelled: true };
    try {
      for await (const line of streamJsonlLines(
        join(directory, filename),
        checkpoint,
      )) {
        if (line.kind === 'cancelled') return { paths, cancelled: true };
        const parsed = parseJsonLine(line);
        if (
          !isRecord(parsed) ||
          typeof parsed.entryId !== 'string' ||
          typeof parsed.transcriptPath !== 'string' ||
          parsed.transcriptPath.length === 0 ||
          !relevantIds.has(parsed.entryId)
        ) {
          continue;
        }
        paths.set(parsed.entryId, parsed.transcriptPath);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  return { paths, cancelled: false };
}

function firstUsableSessionId(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== 'result') return undefined;
  const sessionId = value.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  return readClaudeRunningTotals(value) === undefined ? undefined : sessionId;
}

async function discoverTranscriptSession(
  path: string,
  checkpoint: () => Promise<boolean>,
): Promise<{
  sessionId?: string;
  cancelled: boolean;
}> {
  try {
    for await (const line of streamJsonlLines(path, checkpoint)) {
      if (line.kind === 'cancelled') {
        return { cancelled: true };
      }
      if (line.kind === 'oversized') continue;
      const parsed = parseJsonLine(line);
      const sessionId = firstUsableSessionId(parsed);
      if (sessionId !== undefined) {
        return { sessionId, cancelled: false };
      }
    }
  } catch (error) {
    if (isEnoent(error)) return { cancelled: false };
    throw error;
  }
  return { cancelled: false };
}

function addModelUsage(
  aggregate: Map<string, AgentAuditModelUsage>,
  updates: readonly AgentAuditModelUsage[],
): void {
  for (const update of updates) {
    const previous = aggregate.get(update.model);
    if (previous === undefined) {
      aggregate.set(update.model, { ...update });
      continue;
    }
    const webSearchRequests =
      (previous.webSearchRequests ?? 0) + (update.webSearchRequests ?? 0);
    const costBasis = update.costBasis ?? previous.costBasis;
    aggregate.set(update.model, {
      model: update.model,
      inputTokens: previous.inputTokens + update.inputTokens,
      outputTokens: previous.outputTokens + update.outputTokens,
      cacheReadInputTokens:
        previous.cacheReadInputTokens + update.cacheReadInputTokens,
      cacheCreationInputTokens:
        previous.cacheCreationInputTokens + update.cacheCreationInputTokens,
      ...(webSearchRequests === 0 ? {} : { webSearchRequests }),
      costUsd: previous.costUsd + update.costUsd,
      ...(costBasis === undefined ? {} : { costBasis }),
    });
  }
}

async function replayClaudeCandidate(
  candidate: ClaudeTranscriptCandidate,
  ledger: ClaudeSessionCostLedger,
  checkpoint: () => Promise<boolean>,
): Promise<{
  cancelled: boolean;
  missing: boolean;
  derivedCost: number;
  cumulativeCostUsd?: number;
  modelUsage: AgentAuditModelUsage[];
  exact: boolean;
}> {
  let derivedCost = 0;
  let cumulativeCostUsd: number | undefined;
  let exact = true;
  let resultCount = 0;
  let truncated = false;
  const modelUsage = new Map<string, AgentAuditModelUsage>();
  ledger.beginQuery(candidate.entry.id);
  try {
    try {
      for await (const line of streamJsonlLines(
        candidate.transcriptPath,
        checkpoint,
      )) {
        if (line.kind === 'cancelled') {
          return {
            cancelled: true,
            missing: false,
            derivedCost,
            cumulativeCostUsd,
            modelUsage: Array.from(modelUsage.values()),
            exact,
          };
        }
        if (line.kind === 'oversized') continue;
        const parsed = parseJsonLine(line);
        if (!isRecord(parsed)) continue;
        if (parsed.type === 'canopy_transcript_truncated') {
          // Later results were dropped, so the last total is partial.
          truncated = true;
          break;
        }
        if (parsed.type === 'conversation_reset') {
          ledger.noteConversationReset(candidate.entry.id);
          continue;
        }
        if (
          parsed.type !== 'result' ||
          typeof parsed.session_id !== 'string' ||
          parsed.session_id.length === 0
        ) {
          continue;
        }
        const totals = readClaudeRunningTotals(parsed);
        if (totals === undefined) continue;
        const recorded = ledger.recordResult(candidate.entry.id, {
          sessionId: parsed.session_id,
          totals,
          mainLoopUsage: readClaudeMainLoopUsage(parsed),
          ...(candidate.entry.model === undefined
            ? {}
            : { mainModel: candidate.entry.model }),
        });
        resultCount += 1;
        derivedCost += recorded.costUsd;
        cumulativeCostUsd = recorded.cumulativeCostUsd;
        if (recorded.derivation !== 'exact') exact = false;
        addModelUsage(modelUsage, recorded.modelUsage);
      }
    } catch (error) {
      if (isEnoent(error)) {
        return {
          cancelled: false,
          missing: true,
          derivedCost,
          cumulativeCostUsd,
          modelUsage: Array.from(modelUsage.values()),
          exact,
        };
      }
      throw error;
    }
    return {
      cancelled: false,
      // A truncated transcript is handled like a missing one: a gap.
      missing: resultCount === 0 || truncated,
      derivedCost,
      cumulativeCostUsd,
      modelUsage: Array.from(modelUsage.values()),
      exact,
    };
  } finally {
    ledger.endQuery(candidate.entry.id);
  }
}

function emptyResult(skipped = false): CostHistoryRepairResult {
  return {
    claudeRepaired: 0,
    claudeSkippedNoTranscript: 0,
    codexDelegationsPriced: 0,
    skipped,
  };
}

async function writeCompletionMarker(markerPath: string): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFileAtomically(
    markerPath,
    `${JSON.stringify({
      version: COST_HISTORY_REPAIR_VERSION,
      completedAt: new Date().toISOString(),
    })}\n`,
  );
}

function codexRepairEntry(
  entry: AgentAuditEntry,
  pricing: OpenAiPricingCacheState,
): { entry: AgentAuditEntry; priced: boolean } {
  const serviceTier = codexServiceTierForModelConfig({});
  const observedCost = computeCodexObservedCost(
    {
      model: entry.model,
      serviceTier,
      usageObserved:
        entry.tokens.input > 0 ||
        entry.tokens.output > 0 ||
        entry.tokens.cacheReadInputTokens > 0 ||
        entry.tokens.cacheCreationInputTokens > 0 ||
        (entry.tokens.reasoningOutputTokens ?? 0) > 0,
      tokens: {
        input: entry.tokens.input,
        output: entry.tokens.output,
        cacheReadInputTokens: entry.tokens.cacheReadInputTokens,
        cacheCreationInputTokens: entry.tokens.cacheCreationInputTokens,
        ...(entry.tokens.reasoningOutputTokens === undefined
          ? {}
          : { reasoningOutputTokens: entry.tokens.reasoningOutputTokens }),
      },
      ...(entry.billableToolCounts === undefined
        ? {}
        : { billableToolCounts: entry.billableToolCounts }),
    },
    pricing,
  );
  return {
    entry: {
      ...entry,
      observedCost,
      ...(typeof observedCost.totalUsd === 'number'
        ? { totalCostUsd: observedCost.totalUsd }
        : {}),
      serviceTier,
      costRepair: { version: COST_HISTORY_REPAIR_VERSION },
    },
    priced: typeof observedCost.totalUsd === 'number',
  };
}

/** Repairs retained historical costs using only the supplied audit directories. */
export async function runCostHistoryRepair(
  options: CostHistoryRepairOptions,
): Promise<CostHistoryRepairResult> {
  if (await markerAlreadyComplete(options.markerPath)) {
    return emptyResult(true);
  }
  if (options.isCancelled?.() === true) return emptyResult();

  const checkpoint = createCheckpoint(options);
  const audit = await readLatestAuditEntries(options.auditDir, checkpoint);
  if (audit.cancelled) return emptyResult();
  const result = emptyResult();

  const claudeEntries: AgentAuditEntry[] = [];
  const codexEntries: AgentAuditEntry[] = [];
  for (const entry of Array.from(audit.entries.values())) {
    if (await checkpoint()) return result;
    if (isClaudeRepairEligible(entry)) claudeEntries.push(entry);
    if (isCodexDelegationEligible(entry)) codexEntries.push(entry);
  }

  const relevantClaudeIds = new Set(claudeEntries.map((entry) => entry.id));
  const indexed = await readTranscriptIndex(
    options.transcriptIndexDir,
    relevantClaudeIds,
    checkpoint,
  );
  if (indexed.cancelled) return result;

  const groupsBySession = new Map<string, ClaudeSessionGroup>();
  // Turns whose result the replay cannot read; the ledger must not span them.
  const gapStartsBySession = new Map<string, string[]>();
  const noteGap = (entry: AgentAuditEntry): void => {
    if (entry.sdkSessionId === undefined) return;
    const gaps = gapStartsBySession.get(entry.sdkSessionId) ?? [];
    gaps.push(entry.startedAt);
    gapStartsBySession.set(entry.sdkSessionId, gaps);
  };
  for (const entry of claudeEntries) {
    if (await checkpoint()) return result;
    const transcriptPath =
      indexed.paths.get(entry.id) ?? options.transcriptPathFor?.(entry);
    if (transcriptPath === undefined) {
      if (!isRepaired(entry)) result.claudeSkippedNoTranscript += 1;
      noteGap(entry);
      continue;
    }
    const discovery = await discoverTranscriptSession(
      transcriptPath,
      checkpoint,
    );
    if (discovery.cancelled) return result;
    if (discovery.sessionId === undefined) {
      if (!isRepaired(entry)) {
        result.claudeSkippedNoTranscript += 1;
      }
      noteGap(entry);
      continue;
    }
    const candidate: ClaudeTranscriptCandidate = {
      entry,
      transcriptPath,
      sessionId: discovery.sessionId,
    };
    const group = groupsBySession.get(discovery.sessionId);
    if (group === undefined) {
      groupsBySession.set(discovery.sessionId, {
        sessionId: discovery.sessionId,
        candidates: [candidate],
      });
    } else {
      group.candidates.push(candidate);
    }
  }

  const groups = Array.from(groupsBySession.values());
  for (const group of groups) {
    group.candidates.sort((left, right) =>
      left.entry.startedAt.localeCompare(right.entry.startedAt),
    );
  }

  let ledger: ClaudeSessionCostLedger | undefined;
  let temporaryDirectory: string | undefined;
  try {
    if (groups.length > 0) {
      temporaryDirectory = await mkdtemp(
        join(process.env.TMPDIR ?? tmpdir(), 'cost-history-repair-'),
      );
      ledger = new ClaudeSessionCostLedger({
        filePath: join(temporaryDirectory, 'claude-session-costs.json'),
        persistDelayMs: 60_000,
      });
    }

    for (const group of groups) {
      if (await checkpoint()) return result;
      let hasSeedResult = false;
      let previousStartedAt: string | undefined;
      const gapStarts = gapStartsBySession.get(group.sessionId) ?? [];
      for (let index = 0; index < group.candidates.length; index += 1) {
        const candidate = group.candidates[index];
        if (candidate === undefined) continue;
        const startedAt = candidate.entry.startedAt;
        const previous = previousStartedAt;
        if (
          previous !== undefined &&
          gapStarts.some((gap) => gap > previous && gap < startedAt)
        ) {
          hasSeedResult = false;
        }
        if (await checkpoint()) return result;
        if (ledger === undefined) {
          throw new Error('Claude cost repair ledger was not initialized');
        }
        const replay = await replayClaudeCandidate(
          candidate,
          ledger,
          checkpoint,
        );
        if (replay.cancelled) return result;
        if (replay.missing) {
          if (!isRepaired(candidate.entry)) {
            result.claudeSkippedNoTranscript += 1;
          }
          hasSeedResult = false;
          continue;
        }
        previousStartedAt = startedAt;
        const isFirstRetainedEntry = !hasSeedResult;
        hasSeedResult = true;
        if (
          isFirstRetainedEntry ||
          isRepaired(candidate.entry) ||
          !replay.exact ||
          replay.cumulativeCostUsd === undefined
        ) {
          continue;
        }
        const previousTotalCostUsd = candidate.entry.totalCostUsd ?? 0;
        if (Math.abs(replay.derivedCost - previousTotalCostUsd) <= 0.005) {
          continue;
        }
        const repaired: AgentAuditEntry = {
          ...candidate.entry,
          totalCostUsd: replay.derivedCost,
          sdkCumulativeCostUsd: replay.cumulativeCostUsd,
          costDerivation: 'exact',
          modelUsage: replay.modelUsage,
          costRepair: {
            version: COST_HISTORY_REPAIR_VERSION,
            previousTotalCostUsd,
          },
        };
        if (await checkpoint()) return result;
        await options.append(repaired);
        result.claudeRepaired += 1;
      }
    }

    for (const entry of codexEntries) {
      if (await checkpoint()) return result;
      const repaired = codexRepairEntry(entry, options.codexPricing());
      if (await checkpoint()) return result;
      await options.append(repaired.entry);
      if (repaired.priced) result.codexDelegationsPriced += 1;
    }
  } finally {
    try {
      if (ledger !== undefined) await ledger.flush();
    } finally {
      if (temporaryDirectory !== undefined) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  if (options.isCancelled?.() === true) return result;
  await options.commit?.();
  await writeCompletionMarker(options.markerPath);
  return result;
}
