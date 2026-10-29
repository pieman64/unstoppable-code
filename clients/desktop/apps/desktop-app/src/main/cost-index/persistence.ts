import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  COST_BILLING_BASES,
  COST_HELPER_KINDS,
  COST_SOURCES,
  type CostBillingBasis,
  type CostTotals,
} from '@canopy/protocol/cost-view';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type {
  CostChatAggregate,
  CostChatFile,
  CostIndexCheckpoint,
  CostInternalTrigger,
  CostSummaryFile,
  CostTurnRecord,
  CostUnattachedFile,
} from './types';

export interface PersistedRead<T> {
  readonly value: T | null;
  readonly corrupt: boolean;
}

let temporaryFileSequence = 0;
let corruptFileSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isTokenTotals(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonnegativeFinite(value.input) &&
    isNonnegativeFinite(value.output) &&
    isNonnegativeFinite(value.cacheReadInputTokens) &&
    isNonnegativeFinite(value.cacheCreationInputTokens) &&
    isNonnegativeFinite(value.reasoningOutputTokens)
  );
}

/** Preserve unsplit usage without accepting malformed optional token counts. */
function hasValidTotalTokens(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.totalTokens === undefined || isNonnegativeFinite(value.totalTokens))
  );
}

/**
 * Billing bases added after version 1 files were first written. A file from
 * an earlier release has no total for them, which means nothing was billed
 * there; reading it as corrupt would throw the user's cost history aside.
 */
const BILLING_BASES_ADDED_AFTER_V1: readonly CostBillingBasis[] = [
  'account_proxy',
];

function isCostTotals(value: unknown): value is CostTotals {
  if (
    !isRecord(value) ||
    !isRecord(value.bySource) ||
    !isRecord(value.byBilling)
  ) {
    return false;
  }
  const bySource = value.bySource;
  const byBilling = value.byBilling;
  for (const basis of BILLING_BASES_ADDED_AFTER_V1) {
    if (byBilling[basis] === undefined) byBilling[basis] = 0;
  }
  return (
    isNonnegativeFinite(value.usd) &&
    COST_SOURCES.every((source) => isNonnegativeFinite(bySource[source])) &&
    COST_BILLING_BASES.every((basis) =>
      isNonnegativeFinite(byBilling[basis]),
    ) &&
    isTokenTotals(value.tokens) &&
    isNonnegativeFinite(value.notPricedCount) &&
    typeof value.hasEstimate === 'boolean'
  );
}

// Typed as a full record so a new provider must be listed before it compiles.
const PERSISTED_PROVIDERS: Readonly<Record<AgentProviderType, true>> = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  opencode: true,
  copilot: true,
};

function isPersistedProvider(value: unknown): value is AgentProviderType {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PERSISTED_PROVIDERS, value)
  );
}

function isRecordAccountProxy(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      isString(value.connectionId) &&
      Array.isArray(value.accounts) &&
      value.accounts.every(
        (account) =>
          isRecord(account) &&
          isString(account.authIndex) &&
          isOptionalString(account.provider) &&
          isNonnegativeFinite(account.requests),
      ))
  );
}

function isCostProxyAccountRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.accountKey) &&
    isString(value.label) &&
    isOptionalString(value.provider) &&
    isNonnegativeFinite(value.turnShare) &&
    isNonnegativeFinite(value.requestCount) &&
    isNonnegativeFinite(value.usd) &&
    isNonnegativeFinite(value.notPricedCount)
  );
}

function isOptionalProxyAccountRows(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every(isCostProxyAccountRow))
  );
}

function isCostTurnRecord(value: unknown): value is CostTurnRecord {
  if (!isRecord(value) || !isRecord(value.tokens)) return false;
  const isSource =
    value.source === 'chat' ||
    value.source === 'pipeline' ||
    value.source === 'background' ||
    value.source === 'delegation';
  const isStatus =
    value.status === 'running' ||
    value.status === 'success' ||
    value.status === 'failure' ||
    value.status === 'cancelled' ||
    value.status === 'interrupted';
  const isProvider = isPersistedProvider(value.provider);
  const isCostStatus =
    value.costStatus === 'reported' ||
    value.costStatus === 'estimated' ||
    value.costStatus === 'partial' ||
    value.costStatus === 'not_priced';
  const isPipeline =
    value.pipeline === undefined ||
    (isRecord(value.pipeline) &&
      isString(value.pipeline.rootExecutionId) &&
      isString(value.pipeline.executionId) &&
      isOptionalString(value.pipeline.pipelineName) &&
      isOptionalString(value.pipeline.jobId) &&
      isOptionalString(value.pipeline.stepId) &&
      (value.pipeline.attempt === undefined ||
        isNonnegativeFinite(value.pipeline.attempt)));
  const isToolCounts =
    value.toolCounts === undefined ||
    (isRecord(value.toolCounts) &&
      Object.values(value.toolCounts).every((count) =>
        isNonnegativeFinite(count),
      ));
  const isAttributedItems =
    (value.subagents === undefined ||
      (Array.isArray(value.subagents) &&
        value.subagents.every(hasValidTotalTokens))) &&
    (value.delegation === undefined || hasValidTotalTokens(value.delegation));
  const isContext =
    value.context === undefined ||
    (isRecord(value.context) &&
      isNonnegativeFinite(value.context.endTokens) &&
      isNonnegativeFinite(value.context.windowTokens) &&
      (value.context.peakTokens === undefined ||
        isNonnegativeFinite(value.context.peakTokens)));
  const isCompactions =
    value.compactions === undefined ||
    (Array.isArray(value.compactions) &&
      value.compactions.every(
        (compaction) =>
          isRecord(compaction) &&
          isString(compaction.at) &&
          (compaction.trigger === 'auto' ||
            compaction.trigger === 'manual' ||
            compaction.trigger === 'unknown'),
      ));

  return (
    isString(value.entryId) &&
    isString(value.day) &&
    isString(value.startedAt) &&
    isOptionalString(value.completedAt) &&
    isStatus &&
    isSource &&
    isOptionalString(value.chatId) &&
    (value.helperKind === undefined ||
      COST_HELPER_KINDS.some((kind) => kind === value.helperKind)) &&
    isPipeline &&
    isProvider &&
    isOptionalString(value.model) &&
    isOptionalString(value.harness) &&
    COST_BILLING_BASES.some((basis) => basis === value.billingBasis) &&
    isTokenTotals(value.tokens) &&
    (value.costUsd === undefined || isNonnegativeFinite(value.costUsd)) &&
    isCostStatus &&
    (value.durationMs === undefined || isNonnegativeFinite(value.durationMs)) &&
    isToolCounts &&
    (value.subagentCount === undefined ||
      isNonnegativeFinite(value.subagentCount)) &&
    (value.toolUseCount === undefined ||
      isNonnegativeFinite(value.toolUseCount)) &&
    isAttributedItems &&
    isContext &&
    isCompactions &&
    (value.planEvents === undefined ||
      (isRecord(value.planEvents) &&
        isNonnegativeFinite(value.planEvents.created) &&
        isNonnegativeFinite(value.planEvents.approved))) &&
    isRecordAccountProxy(value.accountProxy)
  );
}

function isCostModelRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.model) &&
    isNonnegativeFinite(value.turnCount) &&
    isNonnegativeFinite(value.usd) &&
    isNonnegativeFinite(value.notPricedCount) &&
    isTokenTotals(value.tokens)
  );
}

function isCostChatAggregate(value: unknown): value is CostChatAggregate {
  if (
    !isRecord(value) ||
    !isRecord(value.bySource) ||
    !isRecord(value.bySource.chat) ||
    !isRecord(value.bySource.subagents) ||
    !isRecord(value.bySource.delegations) ||
    !isRecord(value.bySource.background) ||
    !isRecord(value.context) ||
    !isRecord(value.compactions) ||
    !isRecord(value.activity)
  )
    return false;
  const bySource = value.bySource;
  const chatSource = bySource.chat;
  const subagentSource = bySource.subagents;
  const delegationSource = bySource.delegations;
  const backgroundSource = bySource.background;
  if (
    !isRecord(chatSource) ||
    !isRecord(subagentSource) ||
    !isRecord(delegationSource) ||
    !isRecord(backgroundSource)
  )
    return false;
  const context = value.context;
  const compactions = value.compactions;
  const activity = value.activity;
  return (
    isCostTotals(value.totals) &&
    isNonnegativeFinite(value.turnCount) &&
    isOptionalString(value.firstActivityAt) &&
    isOptionalString(value.lastActivityAt) &&
    isOptionalString(value.contextCategoriesAt) &&
    typeof value.hasCodexEstimate === 'boolean' &&
    isNonnegativeFinite(chatSource.usd) &&
    isNonnegativeFinite(chatSource.turnCount) &&
    isNonnegativeFinite(subagentSource.usd) &&
    Array.isArray(subagentSource.items) &&
    subagentSource.items.every(hasValidTotalTokens) &&
    isNonnegativeFinite(delegationSource.usd) &&
    Array.isArray(delegationSource.items) &&
    delegationSource.items.every(hasValidTotalTokens) &&
    isNonnegativeFinite(backgroundSource.usd) &&
    Array.isArray(backgroundSource.rows) &&
    Array.isArray(value.chatTurnsByModel) &&
    value.chatTurnsByModel.every(isCostModelRow) &&
    Array.isArray(value.byModel) &&
    value.byModel.every(isCostModelRow) &&
    isOptionalProxyAccountRows(value.byProxyAccount) &&
    Array.isArray(context.categories) &&
    Array.isArray(context.timeline) &&
    isNonnegativeFinite(compactions.total) &&
    isNonnegativeFinite(compactions.auto) &&
    isNonnegativeFinite(compactions.manual) &&
    isNonnegativeFinite(activity.turnCount) &&
    isNonnegativeFinite(activity.totalDurationMs) &&
    (activity.averageTurnMs === null ||
      isNonnegativeFinite(activity.averageTurnMs)) &&
    (activity.p95TurnMs === null || isNonnegativeFinite(activity.p95TurnMs)) &&
    isNonnegativeFinite(activity.toolCallCount) &&
    isNonnegativeFinite(activity.subagentCount) &&
    isNonnegativeFinite(activity.plansCreated) &&
    isNonnegativeFinite(activity.plansApproved) &&
    Array.isArray(activity.topTools) &&
    Array.isArray(value.points) &&
    value.points.every(
      (point) =>
        isRecord(point) &&
        isString(point.startedAt) &&
        (point.durationMs === undefined ||
          isNonnegativeFinite(point.durationMs)) &&
        (point.context === undefined ||
          (isRecord(point.context) &&
            isNonnegativeFinite(point.context.endTokens) &&
            isNonnegativeFinite(point.context.windowTokens) &&
            (point.context.peakTokens === undefined ||
              isNonnegativeFinite(point.context.peakTokens)))) &&
        (point.compaction === undefined ||
          point.compaction === 'auto' ||
          point.compaction === 'manual' ||
          point.compaction === 'unknown'),
    )
  );
}

function isStringRecordOfTurns(
  value: unknown,
): value is Record<string, CostTurnRecord> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([entryId, record]) =>
        isCostTurnRecord(record) && record.entryId === entryId,
    )
  );
}

function isCostChatFile(value: unknown): value is CostChatFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isString(value.chatId) &&
    isStringRecordOfTurns(value.records) &&
    (value.sealed === undefined || isCostChatAggregate(value.sealed)) &&
    (value.sealedEntryIds === undefined ||
      (Array.isArray(value.sealedEntryIds) &&
        value.sealedEntryIds.every(isString)))
  );
}

/**
 * Sealed runs carry their own run and step totals, which later merges add to,
 * so they go through the same totals check as every other persisted total.
 */
function isSealedRuns(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (view) =>
      isRecord(view) &&
      isRecord(view.run) &&
      isCostTotals(view.run.totals) &&
      Array.isArray(view.steps) &&
      view.steps.every((step) => isRecord(step) && isCostTotals(step.totals)) &&
      (view.subagents === undefined ||
        (Array.isArray(view.subagents) &&
          view.subagents.every(hasValidTotalTokens))) &&
      (view.delegations === undefined ||
        (Array.isArray(view.delegations) &&
          view.delegations.every(hasValidTotalTokens))),
  );
}

export function isCostUnattachedFile(
  value: unknown,
): value is CostUnattachedFile {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isStringRecordOfTurns(value.records)
  ) {
    return false;
  }
  if (
    value.sealedUnattached !== undefined &&
    !isCostChatAggregate(value.sealedUnattached)
  ) {
    return false;
  }
  return (
    (value.sealedRuns === undefined || isSealedRuns(value.sealedRuns)) &&
    (value.sealedRunsLastActivityAt === undefined ||
      isString(value.sealedRunsLastActivityAt)) &&
    (value.sealedEntryIds === undefined ||
      (Array.isArray(value.sealedEntryIds) &&
        value.sealedEntryIds.every(isString)))
  );
}

function isCostSummaryFile(value: unknown): value is CostSummaryFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.totals))
    return false;
  const isChat = (chat: unknown): boolean =>
    isRecord(chat) &&
    isString(chat.chatId) &&
    isCostTotals(chat.totals) &&
    isNonnegativeFinite(chat.turnCount) &&
    isOptionalString(chat.firstActivityAt) &&
    isString(chat.lastActivityAt) &&
    Array.isArray(chat.models) &&
    chat.models.every(isString) &&
    typeof chat.running === 'boolean' &&
    typeof chat.hasCodexEstimate === 'boolean' &&
    isOptionalProxyAccountRows(chat.proxyAccounts);
  const isRun = (run: unknown): boolean =>
    isRecord(run) &&
    isString(run.executionId) &&
    isString(run.pipelineName) &&
    isString(run.startedAt) &&
    (run.status === 'running' ||
      run.status === 'succeeded' ||
      run.status === 'failed' ||
      run.status === 'cancelled') &&
    isCostTotals(run.totals) &&
    isNonnegativeFinite(run.agentStepCount);
  return (
    isString(value.projectId) &&
    isString(value.scopeId) &&
    isString(value.incarnation) &&
    (value.updatedAt === null || isString(value.updatedAt)) &&
    isOptionalString(value.sealedAt) &&
    isOptionalString(value.coverageStart) &&
    isNonnegativeFinite(value.retentionDays) &&
    isNonnegativeFinite(value.revision) &&
    isCostTotals(value.totals) &&
    Array.isArray(value.chats) &&
    value.chats.every(isChat) &&
    Array.isArray(value.pipelineRuns) &&
    value.pipelineRuns.every(isRun) &&
    (value.unattached === undefined || isCostTotals(value.unattached)) &&
    typeof value.hasCodexEstimate === 'boolean'
  );
}

function isInternalTrigger(value: unknown): value is CostInternalTrigger {
  return (
    value === 'startup' ||
    value === 'idle' ||
    value === 'open' ||
    value === 'manual' ||
    value === 'turn' ||
    value === 'archive'
  );
}

function isCheckpoint(value: unknown): value is CostIndexCheckpoint {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.firstBuild) ||
    !isRecord(value.audit)
  ) {
    return false;
  }
  if (
    !isString(value.firstBuild.at) ||
    !isString(value.firstBuild.coverageStart) ||
    !isNonnegativeFinite(value.generation)
  ) {
    return false;
  }
  const validCursors = Object.values(value.audit).every(
    (cursor) =>
      isRecord(cursor) &&
      isNonnegativeFinite(cursor.offset) &&
      isNonnegativeFinite(cursor.size) &&
      isNonnegativeFinite(cursor.mtimeMs) &&
      (cursor.ino === undefined || isNonnegativeFinite(cursor.ino)),
  );
  const lastRefresh = value.lastRefresh;
  const validLastRefresh =
    lastRefresh === undefined ||
    (isRecord(lastRefresh) &&
      isInternalTrigger(lastRefresh.trigger) &&
      isString(lastRefresh.startedAt) &&
      isString(lastRefresh.completedAt) &&
      isNonnegativeFinite(lastRefresh.linesRead) &&
      isNonnegativeFinite(lastRefresh.durationMs));
  return validCursors && validLastRefresh;
}

export async function readJsonFile<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
): Promise<PersistedRead<T>> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return { value: null, corrupt: false };
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    await preserveCorruptFile(filePath);
    return { value: null, corrupt: true };
  }
  if (!validate(value)) {
    await preserveCorruptFile(filePath);
    return { value: null, corrupt: true };
  }
  return { value, corrupt: false };
}

export async function readCheckpointFile(
  filePath: string,
): Promise<PersistedRead<CostIndexCheckpoint>> {
  return readJsonFile(filePath, isCheckpoint);
}

export async function readSummaryFile(
  directory: string,
): Promise<PersistedRead<CostSummaryFile>> {
  return readJsonFile(path.join(directory, 'summary.json'), isCostSummaryFile);
}

export async function readChatFile(
  directory: string,
  chatId: string,
): Promise<PersistedRead<CostChatFile>> {
  const result = await readJsonFile(
    chatFilePath(directory, chatId),
    isCostChatFile,
  );
  if (result.value !== null && result.value.chatId !== chatId) {
    await preserveCorruptFile(chatFilePath(directory, chatId));
    return { value: null, corrupt: true };
  }
  return result;
}

export async function readScopeFiles(directory: string): Promise<{
  readonly summary: PersistedRead<CostSummaryFile>;
  readonly chats: readonly CostChatFile[];
  readonly unattached: PersistedRead<CostUnattachedFile>;
  readonly corrupt: boolean;
}> {
  const summary = await readSummaryFile(directory);
  const unattached = await readJsonFile(
    path.join(directory, 'unattached.json'),
    isCostUnattachedFile,
  );
  let corrupt = summary.corrupt || unattached.corrupt;
  let filenames: string[] = [];
  try {
    filenames = await readdir(path.join(directory, 'chats'));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const chats: CostChatFile[] = [];
  for (const filename of filenames.sort()) {
    if (!filename.endsWith('.json')) continue;
    const filePath = path.join(directory, 'chats', filename);
    const result = await readJsonFile(filePath, isCostChatFile);
    if (result.corrupt) corrupt = true;
    if (result.value !== null) chats.push(result.value);
  }
  return { summary, chats, unattached, corrupt };
}

export async function writeChatFile(
  directory: string,
  value: CostChatFile,
): Promise<void> {
  await writeJsonAtomically(chatFilePath(directory, value.chatId), value);
}

export async function writeUnattachedFile(
  directory: string,
  value: CostUnattachedFile,
): Promise<void> {
  await writeJsonAtomically(path.join(directory, 'unattached.json'), value);
}

export async function writeSummaryFile(
  directory: string,
  value: CostSummaryFile,
): Promise<void> {
  await writeJsonAtomically(path.join(directory, 'summary.json'), value);
}

export async function writeCheckpointFile(
  filePath: string,
  value: CostIndexCheckpoint,
): Promise<void> {
  await writeJsonAtomically(filePath, value);
}

export async function writeJsonAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${++temporaryFileSequence}`;
  const contents = `${JSON.stringify(value)}\n`;
  try {
    await writeFile(temporaryPath, contents, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original write error; an absent temporary file is normal.
    }
    throw error;
  }
}

export async function moveDirectoryAside(directory: string): Promise<boolean> {
  try {
    // Incarnation-mismatched state is identity-bound private data, not a
    // recoverable corrupt copy. Never leave it in a sibling of the cost root.
    await rm(directory, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function chatFilePath(directory: string, chatId: string): string {
  const encodedId = Buffer.from(chatId, 'utf8').toString('base64url');
  return path.join(directory, 'chats', `${encodedId}.json`);
}

async function preserveCorruptFile(filePath: string): Promise<void> {
  const destination = `${filePath}.corrupt-${Date.now()}-${++corruptFileSequence}`;
  try {
    await copyFile(filePath, destination);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
