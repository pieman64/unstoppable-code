import { DATA_SHARING_OPT_IN_FEATURES } from '@canopy/protocol/canopy-server';
import {
  mergeGitHubStarPromptRecords,
  mergePlanModeHintRecords,
  migrateLegacyPlanModeHintRecord,
  normalizeGitHubStarPromptRecord,
  normalizePlanModeHintRecord,
} from '@canopy/protocol/onboarding';
import {
  excludeDisabledInstalledItems,
  normalizeDisabledInstalledItems,
  parseInstalledItemKey,
  InstalledItemRefSchema,
  InstalledItemUninstallTargetSchema,
} from '@canopy/protocol/installed-items';
import { z } from 'zod';
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from '@canopy/protocol/release-notes';
import { normalizeClaudeMaxTurns } from '@canopy/desktop-shared/constants/preferences';
import {
  normalizeManagedDelegationMode,
  normalizeManagedDelegationMaxConcurrent,
  normalizeManagedDelegationMaxDepth,
  normalizeManagedDelegationLifetimeLimit,
} from '@canopy/protocol/delegation/discovery';
import { normalizeCodexMaxConcurrentSubagents } from '@canopy/desktop-shared/lib/codex-multi-agent';
import { normalizeAppAdvisorProjectAgentAccess } from '@canopy/desktop-shared/lib/app-advisor-project-agent-access';
import { isSyntacticallyValidModelId } from '@canopy/desktop-shared/lib/model-id';
import {
  createDirectoryDurably,
  writeFileAtomically,
  type AdmittedWriterTarget,
} from './atomic-file';
import {
  markGlobalApprovalRulesChanged,
  markPreferencesAuthorityConfirmed,
  markPreferencesAuthorityUnconfirmed,
  narrowsFileWriteRules,
  trackPreferencesAuthoritySave,
} from '../approvals/rule-revisions';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import { resolveAvailableModel } from './model-availability';
import { readFile, stat } from 'node:fs/promises';
import {
  DEFAULT_CHAT_DETAIL,
  isChatDetail,
  type ChatDetail,
} from '@canopy/protocol/chat-detail';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mcpHttpAuthTargetKey } from '@canopy/desktop-shared/lib/mcp-http-auth';
import { isGatewayRoutableModel } from '@canopy/desktop-shared/lib/gateway-model-availability';
import { normalizeCustomBrowserSearchEngines } from '@canopy/desktop-shared/lib/browser-search-engines';
import {
  isAccountProxyRoutingStrategy,
  normalizeAccountProxyUrl,
} from '@canopy/desktop-shared/lib/account-proxy';
import type {
  AccountProxyConnection,
  AccountProxyConnectionKind,
} from '@canopy/desktop-shared/types/account-proxy';
import {
  isBillingLane,
  type BillingLane,
} from '@canopy/desktop-shared/lib/default-model-lane';
import { isMergeQueueAgentHandling } from '@canopy/desktop-shared/types/github';
import { reconcileSidebarNavLayout } from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import {
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_HANDOFF_SUMMARY_MODEL,
  DEFAULT_LOCAL_MEMORY_MODEL,
  defaultLocalMemoryModel,
  defaultSummaryModel,
  MAX_TERMINAL_DRAWER_HEIGHT,
  MIN_TERMINAL_DRAWER_HEIGHT,
  IN_APP_NOTIFICATION_PLACEMENTS,
  OS_NOTIFICATION_CATEGORY_SOUNDS,
  OS_NOTIFICATION_TOP_LEVEL_SOUNDS,
  getExecutionHarnessForModel,
  getModelSource,
  isNavigationMode,
  isWorkspaceLayoutMode,
  normalizeAgentModelConfig,
  normalizePersistedThinkingLevel,
  clampThinkingLevelForModel,
  resolveKnownModel,
  resolveModelAlias,
  type AgentModelConfig,
  type AgentProviderType,
  type ApprovalDefaults,
  type BranchDisplayMapping,
  type ChatTabPluginSelections,
  type ChatModel,
  type CodeGraphPreferences,
  type InAppNotificationPlacement,
  type InAppNotificationPreferences,
  type McpHttpAuthHandler,
  type McpHttpAuthPreference,
  type McpHttpAuthTarget,
  type ModelDefaultsByProvider,
  type NotificationCategoryMap,
  type OsNotificationCategorySound,
  type OsNotificationPreferences,
  type OsNotificationTopLevelSound,
  type LegacyPlanModeChecklistInput,
  type NativeProviderAccountRecord,
  type PreferencesData,
  type PreferencesFile,
  type PreferencesLoadErrorDetails,
  type PreferencesLoadErrorReason,
  type PreferencesLoadResult,
  type PreferencesProjectionOptions,
  type ProviderModelSelection,
  type ThinkingLevel,
  type WindowBounds,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '@canopy/desktop-shared/constants/preferences';
import {
  isApprovalMode,
  normalizeApprovalRules,
} from '@canopy/desktop-shared/lib/approval-engine';
import {
  APPROVAL_DEFAULT_SURFACES,
  FAIL_CLOSED_APPROVAL_MODE,
  createFailClosedApprovalDefaults,
  type ApprovalMode,
} from '@canopy/desktop-shared/types';
import { normalizeFileIndexingPreferences } from '@canopy/core-runtime/node';
import { normalizeGlobalInstructionsConfig } from '@canopy/desktop-shared/lib/global-instructions';
import { getPreferencesFilePath } from '../lib/paths';
import {
  createPreferencesBackupPath,
  createPreferencesGenerationPath,
  createPreferencesLastGoodPath,
} from './preferences-file-paths';
import { getResolvedCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import { pruneDamagedCopies } from '@canopy/desktop-shared/node/lib/damaged-copies';
import { normalizeStringArray } from './string-utils';
import { normalizePromotionalNotifications } from '@canopy/desktop-shared/lib/promotional-notifications';
import {
  normalizeSuggestionsState,
  parseSuggestionsState,
  SUGGESTION_IDS,
} from '@canopy/protocol/suggestions';
import { commitSuggestionsGate } from './suggestions-gate';
import { normalizeOnboardingTipDismissals } from '@canopy/protocol/onboarding-tips';
import { clampUiScale } from '@canopy/desktop-shared/lib/ui-scale';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { toShortcutPlatform } from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import { installPreferencesNormalizationEnvironment } from '@canopy/desktop-shared/node/preferences/normalization-environment';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import {
  normalizeLastActiveContext,
  isBrowserDrawerTabId,
  isBranchNamePrefixMode,
  isPrInstructionMode,
  isThemeName,
  isColorMode,
  isSidebarAppearance,
  isWorktreeDiffStatsStyle,
  isScrollbarBehavior,
  isChatEnrichmentMode,
  buildOnboardingProfileFields,
  isAiCreditsRoutingMode,
  isChatBillingFramework,
  normalizeTelemetrySharing,
  normalizeString,
  isChatInterfaceMode,
  isBackgroundProcessMode,
  createEmptyPluginSelections,
  normalizeFileLabels,
  normalizePlanDetectionPreferences,
  normalizeGlobalFocusShortcut,
  normalizeActivationQuietHours,
  isTerminalShellProfileId,
  normalizeTerminalPresets,
  normalizeCodexCompatDisabledPlugins,
  normalizeBoolean,
} from '@canopy/desktop-shared/node/preferences/field-normalizers';
import { isRecord } from './type-guards';
export { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';

installPreferencesNormalizationEnvironment({
  resolveAvailableModel: (model) => resolveAvailableModel(model),
  ollamaEnabled: () => __CANOPY_OLLAMA_ENABLED__,
  shortcutPlatform: () => toShortcutPlatform(hostOperatingSystem() ?? 'linux'),
});

/** Preferences sit in the data root itself (`getPreferencesFilePath`). */
function createPreferencesFolderDurably(filePath: string): Promise<void> {
  const dataRoot = dirname(filePath);
  return createDirectoryDurably(dataRoot, { dataRoot });
}

/**
 * Main and last-good carry the generation of the save that wrote them.
 * Files without one (written before CAN-5154) are generation 0.
 */
interface PreferencesDocument extends PreferencesFile {
  generation: number;
}

/**
 * Preferences as read for a save, with the generation they were stored at;
 * null when main's `generation` is not a valid one.
 */
interface StoredPreferences {
  preferences: PreferencesData;
  generation: number | null;
}

interface LastGoodPreferences extends StoredPreferences {
  status: 'ok';
  path: string;
  generation: number;
}

type LastGoodPreferencesRead =
  | LastGoodPreferences
  | { status: 'absent' }
  | { status: 'unreadable'; code?: string };

type PreferencesGenerationRead =
  | { status: 'ok'; generation: number }
  | { status: 'absent' }
  | { status: 'unreadable' };

class PreferencesRecoveryRequiredError extends Error {
  readonly code = 'PREFERENCES_RECOVERY_REQUIRED';

  constructor(readonly details: PreferencesLoadErrorDetails) {
    super('Preferences could not be read. Changes were not saved.');
  }
}

class PreferencesGenerationExhaustedError extends Error {
  readonly code = 'PREFERENCES_GENERATION_EXHAUSTED';

  constructor() {
    super(
      'Preferences are damaged and cannot record another save. Changes were not saved.',
    );
  }
}

class PreferencesGenerationUnknownError extends Error {
  readonly code = 'PREFERENCES_GENERATION_UNKNOWN';

  constructor() {
    super(
      'Preferences could not confirm their latest saved version. Changes were not saved.',
    );
  }
}

type PreferencesUpdater = (
  latest: PreferencesData,
) => Partial<PreferencesData> | null | Promise<Partial<PreferencesData> | null>;
type PreferencesCommitObserver = (committed: PreferencesData) => void;

let writePreferencesQueue: Promise<void> = Promise.resolve();

function enqueuePreferencesOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = writePreferencesQueue.then(operation);
  writePreferencesQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Setup rollback owns a committed enablement value, not a runtime generation.
// Track only durable changes to this field so unrelated preference saves do
// not prevent rollback and a newer disable/re-enable cannot be overwritten.
let openCodeEnabledRevision = 0;
export function getOpenCodeEnabledRevision(): number {
  return openCodeEnabledRevision;
}

// Notification acknowledgement does not restore authority after recovery failed.
const failedPreferencesRecoveries = new Map<
  string,
  { details: PreferencesLoadErrorDetails; fallback: PreferencesData }
>();
let lastPreferencesLoadError: PreferencesLoadErrorDetails | null = null;

function recordFailedPreferencesRecovery(
  details: PreferencesLoadErrorDetails,
  fallback: PreferencesData = DEFAULT_PREFERENCES,
): void {
  failedPreferencesRecoveries.set(details.filePath, { details, fallback });
  lastPreferencesLoadError = details;
  markGlobalApprovalRulesChanged();
  invalidateRendererPreferencesCache();
}

function assertPreferencesWritable(filePath: string): void {
  const failure = failedPreferencesRecoveries.get(filePath);
  if (failure) throw new PreferencesRecoveryRequiredError(failure.details);
}

let preferencesRendererLoadOperation: Promise<PreferencesLoadResult> | null =
  null;
let rendererPreferencesCache: PreferencesData | null = null;
// A failed enabled-profile migration must retry the same candidate rather
// than choosing a fresh answer date on each renderer load or ordinary save.
const osNotificationOfferMigrationTimestamps = new Map<string, string>();
let rendererRuntimeProjection: {
  source: PreferencesData;
  result: PreferencesData;
} | null = null;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return (
    getErrorCode(error) === 'ENOENT' || getErrorMessage(error) === 'ENOENT'
  );
}

function createPreferencesRecoveryError(
  filePath: string,
  reason: PreferencesLoadErrorReason,
  message: string,
  actualVersion?: unknown,
  code?: string,
): PreferencesLoadErrorDetails {
  const timestamp = new Date().toISOString();
  const backupPath = createPreferencesBackupPath(
    filePath,
    `${timestamp}-${randomUUID()}`,
  );
  return {
    timestamp,
    reason,
    message,
    filePath,
    backupPath,
    code,
    expectedVersion: 1,
    actualVersion,
  };
}

function createPreferencesBackupPayload(
  error: PreferencesLoadErrorDetails,
  rawContent: string | null,
  parsedContent: unknown,
): Record<string, unknown> {
  if (isRecord(parsedContent)) {
    const payload: Record<string, unknown> = {
      ...parsedContent,
      __error: error,
    };

    if (rawContent !== null) {
      payload.rawContent = rawContent;
    }

    return payload;
  }

  if (rawContent !== null) {
    return {
      __error: error,
      rawContent,
    };
  }

  return {
    __error: error,
    originalContentUnavailable: true,
  };
}

const PREFERENCES_WRITER: AdmittedWriterTarget = {
  namespace: 'preferences',
  writer: 'electron_main',
  module: 'main/lib/preferences-store',
};

/**
 * Main, last-good, backups and the generation record: resolves once the file
 * and its folder are flushed. An installed write whose folder flush failed
 * rejects with `StorageOutcomeUnknownError`; no caller proceeds past one.
 */
async function writeTextFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  const existingMode = await stat(filePath)
    .then((stats) => stats.mode & 0o7777)
    .catch((error: unknown) => {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    });
  await writeFileAtomically(filePath, content, {
    encoding: 'utf8',
    mode: existingMode,
    durable: true,
    admittedWriter: PREFERENCES_WRITER,
  });
}

function serializePreferencesFile(
  preferences: PreferencesData,
  generation: number,
): string {
  const payload: PreferencesDocument = { version: 1, generation, preferences };
  return JSON.stringify(payload, null, 2);
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 0 without a `generation` (before CAN-5154). Null when one is present but
 * invalid or unsafe: it may hide a newer generation, so it never counts as 0.
 */
function documentGeneration(parsed: Record<string, unknown>): number | null {
  if (parsed.generation === undefined) return 0;
  return isGeneration(parsed.generation) ? parsed.generation : null;
}

/** Only `ENOENT` is absent: any other failure may hide a newer generation. */
async function readPreferencesGeneration(
  filePath: string,
): Promise<PreferencesGenerationRead> {
  let raw: string;
  try {
    raw = await readFile(createPreferencesGenerationPath(filePath), 'utf8');
  } catch (error) {
    return isMissingFileError(error)
      ? { status: 'absent' }
      : { status: 'unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      isGeneration(parsed.generation)
    )
      return { status: 'ok', generation: parsed.generation };
  } catch {
    // A torn record proves nothing about last-good.
  }
  return { status: 'unreadable' };
}

/**
 * Records `generation` durably before main is replaced. Main never holds a
 * generation the record lacks, so a last-good behind the record is stale.
 */
async function writePreferencesGeneration(
  filePath: string,
  generation: number,
): Promise<void> {
  await writeTextFileAtomically(
    createPreferencesGenerationPath(filePath),
    JSON.stringify({ version: 1, generation }),
  );
}

/**
 * The floor last-good sets for a save: its generation, or 0 when it is
 * missing or is not a JSON object (no reader can restore those bytes, and
 * only a later write replaces them). Null, refusing the save, when a read
 * fails other than `ENOENT` or its generation is invalid: either may hide a
 * newer generation.
 */
async function readLastGoodFloor(filePath: string): Promise<number | null> {
  await waitForLastGoodRefresh(filePath);
  let raw: string;
  try {
    raw = await readFile(createPreferencesLastGoodPath(filePath), 'utf8');
  } catch (error) {
    return isMissingFileError(error) ? 0 : null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  return isRecord(parsed) ? documentGeneration(parsed) : 0;
}

/**
 * Above main's and the record's: after a downgrade, main may lag the record.
 * Without a readable record, last-good may be ahead of main too, and a record
 * below it would make it look current. A generation that cannot be known
 * refuses the save.
 */
async function nextPreferencesGeneration(
  filePath: string,
  mainGeneration: number | null,
): Promise<number> {
  if (mainGeneration === null) throw new PreferencesGenerationUnknownError();
  const recorded = await readPreferencesGeneration(filePath);
  const floor =
    recorded.status === 'ok'
      ? recorded.generation
      : await readLastGoodFloor(filePath);
  if (floor === null) throw new PreferencesGenerationUnknownError();
  const next = Math.max(mainGeneration, floor) + 1;
  // Reads reject an unsafe generation, so writing one would lose the record.
  if (!Number.isSafeInteger(next))
    throw new PreferencesGenerationExhaustedError();
  return next;
}

interface LastGoodRefresh {
  /** The newest bytes main confirmed durable that are not written yet. */
  pending: string | null;
  running: Promise<void>;
}

/** Per primary file: at most one refresh running. */
const lastGoodRefreshes = new Map<string, LastGoodRefresh>();

/**
 * Refreshes last-good outside the write queue, so a save's acknowledgement
 * waits only for main. Call only with bytes main has confirmed durable, in
 * commit order: one write per file at a time, each of the newest pending
 * bytes, so an older state never lands after a newer one. Bytes, not the
 * state object: readers share that object. Best-effort: a failure is logged,
 * and a lost refresh leaves the previous confirmed copy. Never waits on the
 * queue: recovery inside it waits for this refresh.
 */
function scheduleLastGoodRefresh(filePath: string, confirmed: string): void {
  const existing = lastGoodRefreshes.get(filePath);
  if (existing) {
    existing.pending = confirmed;
    return;
  }
  const refresh: LastGoodRefresh = {
    pending: confirmed,
    running: Promise.resolve(),
  };
  lastGoodRefreshes.set(filePath, refresh);
  refresh.running = (async (): Promise<void> => {
    for (;;) {
      const next = refresh.pending;
      if (next === null) break;
      refresh.pending = null;
      try {
        await writeTextFileAtomically(
          createPreferencesLastGoodPath(filePath),
          next,
        );
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          'Failed to refresh the last-good preferences backup:',
          error,
        );
      }
    }
    lastGoodRefreshes.delete(filePath);
  })();
}

/**
 * Readers of last-good wait for its pending refresh, so recovery in this
 * process never restores a state older than the newest one main confirmed,
 * such as rules a confirmed save revoked. A crash before the refresh lands
 * leaves the older copy behind the generation record, so recovery refuses it.
 */
async function waitForLastGoodRefresh(filePath: string): Promise<void> {
  await lastGoodRefreshes.get(filePath)?.running;
}

function normalizeParsedPreferencesFile(
  parsed: unknown,
): PreferencesData | null {
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !isRecord(parsed.preferences)
  ) {
    return null;
  }

  return normalizePreferences(parsed.preferences, 'persisted');
}

async function readLastGoodPreferencesFile(
  filePath: string,
): Promise<LastGoodPreferencesRead> {
  await waitForLastGoodRefresh(filePath);
  const lastGoodPath = createPreferencesLastGoodPath(filePath);
  let raw: string;
  try {
    raw = await readFile(lastGoodPath, 'utf8');
  } catch (error) {
    return isMissingFileError(error)
      ? { status: 'absent' }
      : { status: 'unreadable', code: getErrorCode(error) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const preferences = normalizeParsedPreferencesFile(parsed);
    // Unknown generation: it could look current, or legacy, when it is not.
    const generation = isRecord(parsed) ? documentGeneration(parsed) : null;
    if (!preferences || generation === null) {
      return { status: 'unreadable' };
    }

    return { status: 'ok', path: lastGoodPath, preferences, generation };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * Restores a supported last-good file, or latches failed recovery for this
 * process. A supported last-good remains the in-memory display fallback either
 * way, named by `restoredFromPath`; it never becomes authority. Unusable
 * last-good falls back to defaults and is not named.
 */
async function recoverOrServeFallback(
  filePath: string,
  error: PreferencesLoadErrorDetails,
  rawContent: string | null,
  parsedContent: unknown,
  knownLastGood?: LastGoodPreferencesRead,
): Promise<StoredPreferences> {
  const lastGood =
    knownLastGood ?? (await readLastGoodPreferencesFile(filePath));
  try {
    return await recoverPreferencesFile(
      filePath,
      error,
      rawContent,
      parsedContent,
      lastGood,
    );
  } catch (failure) {
    const details =
      failure instanceof PreferencesRecoveryRequiredError
        ? failure.details
        : { ...error, backupPath: undefined };
    // Latched, so this generation never reaches a save.
    if (lastGood.status !== 'ok') {
      recordFailedPreferencesRecovery(details);
      return { preferences: DEFAULT_PREFERENCES, generation: 0 };
    }
    recordFailedPreferencesRecovery(
      { ...details, restoredFromPath: lastGood.path },
      lastGood.preferences,
    );
    return { preferences: lastGood.preferences, generation: 0 };
  }
}

/**
 * Last-good is current only when the generation record proves it: a save
 * whose refresh failed or was lost leaves last-good behind the record, and
 * restoring it would undo that save (Mike, CAN-4469 O5 and Q3). An unreadable
 * record proves nothing, so recovery is refused.
 *
 * With no record file, a profile whose last-good and main carry no generation
 * was saved only by builds before CAN-5154, and its last-good stays the
 * starting point until a save writes the record (Mike, 2026-10-31). Saves
 * write generation 1 or more, so a generation means a record was written and
 * lost: refused. So is an invalid one, which may hide a generation.
 */
async function isLastGoodCurrent(
  filePath: string,
  lastGood: LastGoodPreferences,
  parsedMain: unknown,
): Promise<boolean> {
  const recorded = await readPreferencesGeneration(filePath);
  if (recorded.status === 'ok')
    return lastGood.generation >= recorded.generation;
  return (
    recorded.status === 'absent' &&
    lastGood.generation === 0 &&
    !(isRecord(parsedMain) && documentGeneration(parsedMain) !== 0)
  );
}

async function recoverPreferencesFile(
  filePath: string,
  error: PreferencesLoadErrorDetails,
  rawContent: string | null,
  parsedContent: unknown,
  lastGood: LastGoodPreferencesRead,
): Promise<StoredPreferences> {
  // Unreadable bytes and newer formats are not evidence we may replace.
  if (
    lastGood.status !== 'ok' ||
    error.reason === 'version' ||
    (error.reason === 'read' && error.code !== 'ENOENT')
  ) {
    throw new PreferencesRecoveryRequiredError({
      ...error,
      backupPath: undefined,
    });
  }
  if (!(await isLastGoodCurrent(filePath, lastGood, parsedContent))) {
    throw new PreferencesRecoveryRequiredError({
      ...error,
      backupPath: undefined,
      message: `${error.message} The last known good preferences may be older than the latest save, so they were not restored.`,
    });
  }
  const recoveryError = { ...error, restoredFromPath: lastGood.path };
  const backupPath = recoveryError.backupPath;
  if (!backupPath)
    throw new Error('Preferences recovery backup path is missing.');
  let backupWritten = false;
  try {
    await createPreferencesFolderDurably(filePath);
    await writeTextFileAtomically(
      backupPath,
      JSON.stringify(
        createPreferencesBackupPayload(
          recoveryError,
          rawContent,
          parsedContent,
        ),
        null,
        2,
      ),
    );
    backupWritten = true;
    await pruneDamagedCopies({
      directory: dirname(filePath),
      prefix: 'preferences.backup-',
      suffix: '.json',
      uniqueTail: true,
    });
    await writeTextFileAtomically(
      filePath,
      serializePreferencesFile(lastGood.preferences, lastGood.generation),
    );
  } catch (failure) {
    throw new PreferencesRecoveryRequiredError({
      ...recoveryError,
      backupPath: backupWritten ? backupPath : undefined,
      message: `Automatic preferences recovery failed: ${getErrorMessage(failure)}`,
    });
  }
  // The source is already good. Rewriting it adds a destructive failure stage.
  markGlobalApprovalRulesChanged();
  rendererPreferencesCache = lastGood.preferences;
  lastPreferencesLoadError = recoveryError;
  return { preferences: lastGood.preferences, generation: lastGood.generation };
}

function normalizeThinkingLevel(
  value: unknown,
  fallback: ThinkingLevel = 'high',
): ThinkingLevel {
  return normalizePersistedThinkingLevel(value, fallback);
}

function normalizeOptionalThinkingLevel(value: unknown): ThinkingLevel | null {
  if (typeof value !== 'string') return null;
  const fallback: ThinkingLevel = 'off';
  const normalized = normalizeThinkingLevel(value, fallback);
  return normalized === fallback && value !== fallback ? null : normalized;
}

type ModelSelectionValidation = 'runtime' | 'persisted';

function normalizeProviderModel(
  value: unknown,
  provider: AgentProviderType,
  validation: ModelSelectionValidation,
): ChatModel | null {
  if (validation === 'persisted') {
    return normalizePersistableModelSelection(value);
  }
  if (typeof value !== 'string') return null;
  const model = resolveKnownModel(value);
  if (!model) return null;
  if (provider === 'ollama') {
    return getModelSource(model) === 'ollama' && __CANOPY_OLLAMA_ENABLED__
      ? model
      : null;
  }
  if (getModelSource(model) === 'ai-gateway') return null;
  return getExecutionHarnessForModel(model) === provider ? model : null;
}

function normalizeAiCreditsModel(
  value: unknown,
  validation: ModelSelectionValidation,
): ChatModel | null {
  if (validation === 'persisted') {
    return normalizePersistableModelSelection(value);
  }
  if (typeof value !== 'string') return null;
  const model = resolveKnownModel(value);
  return model && isGatewayRoutableModel(model) ? model : null;
}

function normalizeProviderSelection(
  value: unknown,
  provider: AgentProviderType,
  fallback: ProviderModelSelection,
  validation: ModelSelectionValidation,
): ProviderModelSelection {
  if (!isRecord(value)) return fallback;
  const model =
    normalizeProviderModel(value.model, provider, validation) ?? fallback.model;
  const thinkingLevel = normalizeThinkingLevel(
    value.thinkingLevel,
    fallback.thinkingLevel,
  );
  return { model, thinkingLevel };
}

function normalizeNullableOllamaSelection(
  value: unknown,
  validation: ModelSelectionValidation,
): ProviderModelSelection | null {
  if (!isRecord(value)) return null;
  const model = normalizeProviderModel(value.model, 'ollama', validation);
  if (!model) return null;
  const thinkingLevel = normalizeThinkingLevel(value.thinkingLevel, 'high');
  return { model, thinkingLevel };
}

function normalizeNullableAiCreditsSelection(
  value: unknown,
  validation: ModelSelectionValidation,
): ProviderModelSelection | null {
  if (!isRecord(value)) return null;
  const model = normalizeAiCreditsModel(value.model, validation);
  if (!model) return null;
  return {
    model,
    thinkingLevel: normalizeThinkingLevel(value.thinkingLevel, 'high'),
  };
}

function normalizeModelDefaultsByProvider(
  value: unknown,
  fallback: ModelDefaultsByProvider,
  validation: ModelSelectionValidation,
): ModelDefaultsByProvider {
  if (!isRecord(value)) {
    return {
      claude: { ...fallback.claude },
      codex: { ...fallback.codex },
      ollama: fallback.ollama ? { ...fallback.ollama } : null,
      aiCredits: fallback.aiCredits ? { ...fallback.aiCredits } : null,
    };
  }
  return {
    claude: normalizeProviderSelection(
      value.claude,
      'claude',
      fallback.claude,
      validation,
    ),
    codex: normalizeProviderSelection(
      value.codex,
      'codex',
      fallback.codex,
      validation,
    ),
    ollama: normalizeNullableOllamaSelection(value.ollama, validation),
    aiCredits: normalizeNullableAiCreditsSelection(value.aiCredits, validation),
  };
}

/**
 * Normalizes one persisted surface key.
 *
 * A key that is simply ABSENT never had a user choice, so it takes the product
 * default. A key that is PRESENT but malformed is corrupt persisted state, and
 * resolving corruption *upward* to Full Access would silently escalate a user
 * who had chosen Ask — so it fails closed instead (CAN-3055). Keeping these two
 * cases distinct is the whole point; do not collapse them back onto `fallback`.
 */
function normalizeApprovalDefaultKey(
  value: Record<string, unknown>,
  key: keyof ApprovalDefaults,
  fallback: ApprovalDefaults,
): ApprovalMode {
  const persisted = value[key];
  if (isApprovalMode(persisted)) {
    return persisted;
  }
  return persisted === undefined ? fallback[key] : FAIL_CLOSED_APPROVAL_MODE;
}

function normalizeApprovalDefaults(
  value: unknown,
  fallback: ApprovalDefaults,
): ApprovalDefaults {
  if (value === undefined) {
    // Never persisted: no user choice was ever made, so take the product
    // default. This is the fresh-install path.
    return { ...fallback };
  }
  if (!isRecord(value)) {
    // Present but not even an object (`null`, a string, an array, a number):
    // corrupt persisted state, exactly like a malformed per-key value. Falling
    // back to the product default here would resolve corruption UPWARD to Full
    // Access and silently escalate a user who had chosen Ask (CAN-3055).
    return createFailClosedApprovalDefaults();
  }
  const normalized = { ...fallback };
  for (const surface of APPROVAL_DEFAULT_SURFACES) {
    normalized[surface] = normalizeApprovalDefaultKey(value, surface, fallback);
  }
  return normalized;
}

function normalizeProviderModelConfigDefaults(
  value: unknown,
  legacyCodexFastModeDefaultEnabled: unknown,
): Partial<Record<AgentProviderType, AgentModelConfig>> {
  const result: Partial<Record<AgentProviderType, AgentModelConfig>> = {};
  const source = isRecord(value) ? value : {};
  const providers: AgentProviderType[] = ['claude', 'codex', 'ollama'];

  for (const provider of providers) {
    const normalized = normalizeAgentModelConfig(source[provider]);
    if (normalized) {
      result[provider] = normalized;
    }
  }

  const codexHasExplicitFastMode = typeof result.codex?.fastMode === 'boolean';
  if (
    !codexHasExplicitFastMode &&
    typeof legacyCodexFastModeDefaultEnabled === 'boolean'
  ) {
    result.codex = {
      ...(result.codex ?? {}),
      fastMode: legacyCodexFastModeDefaultEnabled,
    };
  } else if (!codexHasExplicitFastMode) {
    result.codex = {
      ...(result.codex ?? {}),
      fastMode:
        DEFAULT_PREFERENCES.providerModelConfigDefaults.codex?.fastMode ??
        false,
    };
  }

  return result;
}

function normalizeDefaultProvider(
  value: unknown,
  byProvider: ModelDefaultsByProvider,
  fallback: AgentProviderType,
): AgentProviderType {
  const candidate =
    value === 'claude' || value === 'codex' || value === 'ollama'
      ? value
      : fallback;
  if (candidate === 'ollama' && byProvider.ollama === null) {
    return 'claude';
  }
  return candidate;
}

function isLaneScopeRecord(
  value: unknown,
): value is { chat?: unknown; worktree?: unknown } {
  // Arrays must NOT qualify. `typeof [] === 'object'`, so a corrupt
  // `lastResolvedDefaultLaneByScope: []` used to pass here and — now that an
  // empty-but-present map means "deliberate full erasure" — would be persisted
  // as one instead of falling through to the legacy-scalar migration, silently
  // discarding lane stickiness the file still carried.
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize the per-scope resolved-lane map, seeding each scope from the legacy
 * scope-agnostic `lastResolvedDefaultLane` so an existing preferences file
 * keeps its lane stickiness across the upgrade.
 *
 * The seed is a MIGRATION, so it only applies when the per-scope map is absent
 * (or unusable) entirely. Once the map exists, an absent slot is a deliberate
 * erasure — `default-model-lane-resolver.ts` drops a scope whose lane it
 * CONFIRMED unavailable, from every scope at once, while the scalar can survive
 * holding a different lane. Re-seeding from that scalar silently undid half the
 * erase on the very next normalize, resurrecting a lane the user no longer has.
 */
function normalizeLastResolvedLaneByScope(
  raw: unknown,
  legacy: unknown,
): Pick<PreferencesData, 'lastResolvedDefaultLaneByScope'> {
  const hasScopeRecord = isLaneScopeRecord(raw);
  const scopes: { chat?: unknown; worktree?: unknown } = hasScopeRecord
    ? raw
    : {};
  const readScope = (key: 'chat' | 'worktree'): BillingLane | undefined => {
    const value = scopes[key];
    if (isBillingLane(value)) return value;
    // An ABSENT slot in a map that EXISTS is a deliberate erasure, not a gap to
    // migrate. A CORRUPT slot still falls through to the legacy seed below —
    // the resolver never writes one, so that can only come from a damaged file.
    if (hasScopeRecord && value === undefined) return undefined;
    return isBillingLane(legacy) ? legacy : undefined;
  };
  const chat = readScope('chat');
  const worktree = readScope('worktree');
  if (!chat && !worktree) {
    // A FULLY erased map must survive as an empty-but-present marker.
    // Normalization runs on the WRITE path too, so returning `{}` here dropped
    // the key before it ever reached disk — making a deliberate erasure
    // indistinguishable from "this file predates the map". The next read then
    // took the migration branch above and re-seeded BOTH scopes from the
    // surviving scalar, resurrecting the lane that was just erased.
    //
    // The scalar is usually cleared in the same atomic write
    // (`flushResolvedLanePersistence`), which hid this for the common case —
    // but not when the scalar holds a DIFFERENT lane than the one erased.
    return hasScopeRecord ? { lastResolvedDefaultLaneByScope: {} } : {};
  }
  return {
    lastResolvedDefaultLaneByScope: {
      ...(chat ? { chat } : {}),
      ...(worktree ? { worktree } : {}),
    },
  };
}

function normalizeWindowBounds(value: unknown): WindowBounds | null {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const x = obj.x;
  const y = obj.y;
  const width = obj.width;
  const height = obj.height;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  if (width < 800 || height < 500) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * Validate the persisted App Advisor window bounds. The preference key
 * `appAdvisorDialogBounds` is legacy-named — it was retained from the
 * earlier floating-dialog implementation to avoid a preference migration —
 * but the persisted value is now the standalone App Advisor
 * `BrowserWindow` bounds. The size floor matches the App Advisor
 * window's minimum usable dimensions; invalid values return `null` so
 * the window can fall back to its built-in default size.
 */
function normalizeAppAdvisorDialogBounds(
  value: unknown,
): PreferencesData['appAdvisorDialogBounds'] {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const { x, y, width, height } = obj;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width < 360 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height < 360
  ) {
    return null;
  }
  return { x, y, width, height };
}

function isValidMappingItem(item: unknown): item is BranchDisplayMapping {
  if (typeof item !== 'object' || item === null) return false;
  if (
    !('id' in item) ||
    !('label' in item) ||
    !('matcher' in item) ||
    !('result' in item) ||
    !('enabled' in item) ||
    !('builtin' in item) ||
    !('settings' in item)
  )
    return false;
  if (
    typeof item.id !== 'string' ||
    typeof item.label !== 'string' ||
    typeof item.matcher !== 'string' ||
    typeof item.result !== 'string' ||
    typeof item.enabled !== 'boolean' ||
    typeof item.builtin !== 'boolean' ||
    typeof item.settings !== 'object' ||
    item.settings === null
  )
    return false;
  // Validate examples/readonlyExampleCount if present; normalization backfills defaults
  if ('examples' in item && !Array.isArray(item.examples)) return false;
  if (
    'readonlyExampleCount' in item &&
    typeof item.readonlyExampleCount !== 'number'
  )
    return false;
  if (!('replaceHyphens' in item.settings) || !('capitalize' in item.settings))
    return false;
  return (
    typeof item.settings.replaceHyphens === 'boolean' &&
    typeof item.settings.capitalize === 'boolean'
  );
}

function normalizeBranchDisplayMappings(
  value: unknown,
): BranchDisplayMapping[] {
  if (!Array.isArray(value)) return DEFAULT_PREFERENCES.branchDisplayMappings;
  return value.filter(isValidMappingItem).map((item: BranchDisplayMapping) => ({
    ...item,
    examples: Array.isArray(item.examples)
      ? item.examples.filter((v: unknown): v is string => typeof v === 'string')
      : [],
    readonlyExampleCount:
      typeof item.readonlyExampleCount === 'number' &&
      Number.isFinite(item.readonlyExampleCount)
        ? Math.max(0, Math.round(item.readonlyExampleCount))
        : 0,
  }));
}

function normalizeTwoPartRefs<T>(
  value: unknown,
  firstKey: string,
  secondKey: string,
  createRef: (first: string, second: string) => T,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const first = entry[firstKey];
    const second = entry[secondKey];
    if (typeof first !== 'string' || typeof second !== 'string') {
      continue;
    }

    const normalizedFirst = first.trim();
    const normalizedSecond = second.trim();
    if (normalizedFirst.length === 0 || normalizedSecond.length === 0) {
      continue;
    }

    const stableKey = `${normalizedFirst}/${normalizedSecond}`;
    if (seen.has(stableKey)) {
      continue;
    }

    seen.add(stableKey);
    result.push(createRef(normalizedFirst, normalizedSecond));
  }

  return result;
}

function isMcpHttpAuthHandler(value: unknown): value is McpHttpAuthHandler {
  return value === 'canopy' || value === 'provider' || value === 'account';
}

function normalizeMcpHttpAuthTarget(value: unknown): McpHttpAuthTarget | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.kind === 'standalone') {
    return typeof value.serverId === 'string' &&
      value.serverId.trim().length > 0 &&
      typeof value.configId === 'string' &&
      value.configId.trim().length > 0
      ? {
          kind: 'standalone',
          serverId: value.serverId.trim(),
          configId: value.configId.trim(),
        }
      : null;
  }

  if (value.kind === 'plugin') {
    return typeof value.marketplaceId === 'string' &&
      value.marketplaceId.trim().length > 0 &&
      typeof value.pluginName === 'string' &&
      value.pluginName.trim().length > 0 &&
      typeof value.serverName === 'string' &&
      value.serverName.trim().length > 0
      ? {
          kind: 'plugin',
          marketplaceId: value.marketplaceId.trim(),
          pluginName: value.pluginName.trim(),
          serverName: value.serverName.trim(),
        }
      : null;
  }

  return null;
}

function normalizeMcpHttpAuthPreferences(
  value: unknown,
): McpHttpAuthPreference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byKey = new Map<string, McpHttpAuthPreference>();
  for (const entry of value) {
    if (!isRecord(entry) || !isMcpHttpAuthHandler(entry.handler)) {
      continue;
    }

    const target = normalizeMcpHttpAuthTarget(entry.target);
    if (!target) {
      continue;
    }

    byKey.set(mcpHttpAuthTargetKey(target), {
      target,
      handler: entry.handler,
    });
  }

  return Array.from(byKey.values());
}

export function normalizeChatTabPluginSelections(
  value: unknown,
): ChatTabPluginSelections {
  if (!isRecord(value)) {
    return createEmptyPluginSelections();
  }

  const skillRefs = normalizeTwoPartRefs(
    value.skillRefs,
    'sourceId',
    'skillName',
    (sourceId, skillName) => ({ sourceId, skillName }),
  );
  const pluginRefs = normalizeTwoPartRefs(
    value.pluginRefs,
    'marketplaceId',
    'pluginName',
    (marketplaceId, pluginName) => ({ marketplaceId, pluginName }),
  );
  const mcpServerRefs = normalizeTwoPartRefs(
    value.mcpServerRefs,
    'serverId',
    'configId',
    (serverId, configId) => ({ serverId, configId }),
  );

  const mcpHttpAuthPreferences = normalizeMcpHttpAuthPreferences(
    value.mcpHttpAuthPreferences,
  );
  // Accept either `collectionIds` (canonical) or the deprecated `bundleIds`
  // alias on input, merge + de-duplicate them, and persist only
  // `collectionIds` on output.
  const collectionIdsInput = normalizeStringArray(value.collectionIds);
  const legacyBundleIds = normalizeStringArray(value.bundleIds);
  const seen = new Set<string>();
  const collectionIds: string[] = [];
  for (const id of [...collectionIdsInput, ...legacyBundleIds]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    collectionIds.push(id);
  }
  return {
    collectionIds,
    skillRefs,
    pluginRefs,
    mcpServerRefs,
    ...(mcpHttpAuthPreferences.length > 0 ? { mcpHttpAuthPreferences } : {}),
  };
}

const VALID_TOP_LEVEL_SOUNDS = new Set<string>(
  OS_NOTIFICATION_TOP_LEVEL_SOUNDS,
);
const VALID_CATEGORY_SOUNDS = new Set<string>(OS_NOTIFICATION_CATEGORY_SOUNDS);
const VALID_IN_APP_NOTIFICATION_PLACEMENTS = new Set<string>(
  IN_APP_NOTIFICATION_PLACEMENTS,
);

function isTopLevelSound(value: unknown): value is OsNotificationTopLevelSound {
  return typeof value === 'string' && VALID_TOP_LEVEL_SOUNDS.has(value);
}

function isCategorySound(value: unknown): value is OsNotificationCategorySound {
  return typeof value === 'string' && VALID_CATEGORY_SOUNDS.has(value);
}

function isInAppNotificationPlacement(
  value: unknown,
): value is InAppNotificationPlacement {
  return (
    typeof value === 'string' && VALID_IN_APP_NOTIFICATION_PLACEMENTS.has(value)
  );
}

function normalizeTopLevelSound(
  value: unknown,
  fallback: OsNotificationTopLevelSound,
): OsNotificationTopLevelSound {
  return isTopLevelSound(value) ? value : fallback;
}

function normalizeCategorySound(
  value: unknown,
  fallback: OsNotificationCategorySound,
): OsNotificationCategorySound {
  return isCategorySound(value) ? value : fallback;
}

function normalizeInAppNotificationPlacement(
  value: unknown,
): InAppNotificationPlacement | undefined {
  return isInAppNotificationPlacement(value) ? value : undefined;
}

function normalizeLegacyInAppChatActivityToasts(
  value: unknown,
  fallback: boolean,
): boolean {
  if (!isRecord(value)) {
    return fallback;
  }

  return normalizeBoolean(value.showInAppChatActivityToasts, fallback);
}

function normalizeNotificationCategories(
  value: unknown,
  fallback: NotificationCategoryMap,
): NotificationCategoryMap {
  if (!isRecord(value)) {
    return { ...fallback };
  }
  return {
    chat: normalizeBoolean(value.chat, fallback.chat),
    script: normalizeBoolean(value.script, fallback.script),
    hook: normalizeBoolean(value.hook, fallback.hook),
    gitCommit: normalizeBoolean(value.gitCommit, fallback.gitCommit),
    gitPush: normalizeBoolean(value.gitPush, fallback.gitPush),
    prCreate: normalizeBoolean(value.prCreate, fallback.prCreate),
    pipeline: normalizeBoolean(value.pipeline, fallback.pipeline),
    terminal: normalizeBoolean(value.terminal, fallback.terminal),
    runComment: normalizeBoolean(value.runComment, fallback.runComment),
    activation: normalizeBoolean(value.activation, fallback.activation),
  };
}

function normalizeInAppNotifications(
  value: unknown,
  legacyOsNotificationsValue: unknown,
): InAppNotificationPreferences {
  const fallback = DEFAULT_PREFERENCES.inAppNotifications;
  const legacyEnabled = normalizeLegacyInAppChatActivityToasts(
    legacyOsNotificationsValue,
    fallback.enabled,
  );

  if (!isRecord(value)) {
    return {
      enabled: legacyEnabled,
      categories: { ...fallback.categories },
    };
  }

  const legacyShowChatActivityToasts = normalizeBoolean(
    value.showChatActivityToasts,
    legacyEnabled,
  );

  const placementChosen = value.placementChosen === true;
  const storedPlacement = normalizeInAppNotificationPlacement(value.placement);
  // Older builds wrote `bottom-right` as the default on every save. Only a
  // corner the user picked is kept, so the default can change.
  const placement =
    storedPlacement === 'bottom-right' && !placementChosen
      ? undefined
      : storedPlacement;
  return {
    enabled: normalizeBoolean(value.enabled, legacyShowChatActivityToasts),
    ...(placement === undefined
      ? {}
      : { placement, ...(placementChosen ? { placementChosen: true } : {}) }),
    categories: normalizeNotificationCategories(
      value.categories,
      fallback.categories,
    ),
  };
}

function normalizeOsNotifications(value: unknown): OsNotificationPreferences {
  const fallback = DEFAULT_PREFERENCES.osNotifications;

  if (!isRecord(value)) {
    return fallback;
  }

  const categories = normalizeNotificationCategories(
    value.categories,
    fallback.categories,
  );

  const rawCategorySounds = value.categorySounds;
  const categorySounds = isRecord(rawCategorySounds)
    ? {
        chat: normalizeCategorySound(
          rawCategorySounds.chat,
          fallback.categorySounds.chat,
        ),
        script: normalizeCategorySound(
          rawCategorySounds.script,
          fallback.categorySounds.script,
        ),
        hook: normalizeCategorySound(
          rawCategorySounds.hook,
          fallback.categorySounds.hook,
        ),
        gitCommit: normalizeCategorySound(
          rawCategorySounds.gitCommit,
          fallback.categorySounds.gitCommit,
        ),
        gitPush: normalizeCategorySound(
          rawCategorySounds.gitPush,
          fallback.categorySounds.gitPush,
        ),
        prCreate: normalizeCategorySound(
          rawCategorySounds.prCreate,
          fallback.categorySounds.prCreate,
        ),
        pipeline: normalizeCategorySound(
          rawCategorySounds.pipeline,
          fallback.categorySounds.pipeline,
        ),
        terminal: normalizeCategorySound(
          rawCategorySounds.terminal,
          fallback.categorySounds.terminal,
        ),
        runComment: normalizeCategorySound(
          rawCategorySounds.runComment,
          fallback.categorySounds.runComment,
        ),
        activation: normalizeCategorySound(
          rawCategorySounds.activation,
          fallback.categorySounds.activation,
        ),
      }
    : fallback.categorySounds;

  return {
    enabled: normalizeBoolean(value.enabled, fallback.enabled),
    skipWhenFocused: normalizeBoolean(
      value.skipWhenFocused,
      fallback.skipWhenFocused,
    ),
    defaultSound: normalizeTopLevelSound(
      value.defaultSound,
      fallback.defaultSound,
    ),
    categories,
    categorySounds,
  };
}

type PreferencesInput =
  | Partial<PreferencesData>
  | Record<string, unknown>
  | undefined;

interface NormalizedLayoutPreferences {
  worktreePanelPercent: number;
  activityPanelWidthPercent: number;
  kanbanWorktreePanelPercent: number;
  kanbanActivityPanelWidthPercent: number;
}

interface NormalizedProviderDefaults {
  defaultChatProvider: AgentProviderType;
  defaultChatModelByProvider: ModelDefaultsByProvider;
  defaultWorktreeProvider: AgentProviderType;
  defaultWorktreeModelByProvider: ModelDefaultsByProvider;
}

interface NormalizedRuntimeLimits {
  scriptTimeoutMinutes: number;
  auditRetentionDays: number;
  automationRunRetentionDays: number;
  codexAppServerIdleTimeoutMinutes: number;
  claudeSessionIdleTimeoutMinutes: number;
  maxActiveChatTurns: number | null;
  maxActivePipelineExecutions: number | null;
  memoryPressureGuardEnabled: boolean;
  bypassCodexAppServerIdleTimeoutUnderCriticalPressure: boolean;
  memoryPressureWarningThresholdBytes: number;
  memoryPressureCriticalThresholdBytes: number;
}

export function normalizePersistableModelSelection(
  model: unknown,
): string | null {
  return isSyntacticallyValidModelId(model) ? resolveModelAlias(model) : null;
}

function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: string,
  validation: ModelSelectionValidation,
): string;
function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: null,
  validation: ModelSelectionValidation,
): string | null;
function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: string | null,
  validation: ModelSelectionValidation,
): string | null;
function normalizePersistableModelSelectionOrDefault(
  model: unknown,
  fallback: string | null,
  validation: ModelSelectionValidation,
): string | null {
  return (
    (validation === 'persisted'
      ? normalizePersistableModelSelection(model)
      : resolveAvailableModel(model)) ?? fallback
  );
}

interface UserSelectedModelOptions {
  /**
   * Keep a chosen model that is not available right now instead of swapping
   * in the default. For features whose model choice is a data boundary (local
   * memory may be kept on a local model on purpose): their runs refuse an
   * unavailable model rather than send data to another provider.
   */
  keepUnavailableChoice?: boolean;
}

/**
 * A model preference the user may leave on its default. Persisted data keeps
 * the stored value as written. At runtime the model follows the
 * provider-aware default until the user picks one, so a default never names a
 * provider this install cannot run and later default changes reach it; a
 * chosen model that is no longer available falls back to the default too,
 * unless `keepUnavailableChoice` keeps it.
 */
function normalizeUserSelectedModel(
  model: unknown,
  setByUser: unknown,
  defaults: { stored: string; providerAware: () => string },
  validation: ModelSelectionValidation,
  options: UserSelectedModelOptions = {},
): { model: string; setByUser: boolean } {
  if (validation === 'persisted') {
    const stored = normalizePersistableModelSelection(model);
    return stored === null
      ? { model: defaults.stored, setByUser: false }
      : { model: stored, setByUser: setByUser === true };
  }
  const selected =
    setByUser === true
      ? (resolveAvailableModel(model) ??
        (options.keepUnavailableChoice
          ? normalizePersistableModelSelection(model)
          : null))
      : null;
  return selected === null
    ? { model: defaults.providerAware(), setByUser: false }
    : { model: selected, setByUser: true };
}

/** Pipeline Advisor accepts every currently executable model. */
function normalizePersistablePipelineAdvisorModel(
  model: unknown,
  validation: ModelSelectionValidation,
): string | null {
  if (validation === 'persisted') {
    return normalizePersistableModelSelection(model);
  }
  if (typeof model !== 'string') return null;
  const resolved = resolveKnownModel(model);
  return resolved &&
    getExecutionHarnessForModel(resolved) &&
    getExecutionHarnessForModel(resolved) !== 'cursor'
    ? resolved
    : null;
}

function normalizePersistablePipelineAdvisorModelOrDefault(
  model: unknown,
  fallback: string,
  validation: ModelSelectionValidation,
): string {
  return (
    normalizePersistablePipelineAdvisorModel(model, validation) ?? fallback
  );
}

function normalizeFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeNullablePositiveInteger(
  value: unknown,
  fallback: number | null,
  max: number,
): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampNumber(Math.round(value), 1, max);
  }
  return fallback;
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampNumber(Math.round(value), 1, max);
  }
  return fallback;
}

export function normalizeCodeGraphPreferences(
  value: unknown,
): CodeGraphPreferences {
  const record = isRecord(value) ? value : undefined;
  const mode =
    record?.mode === 'disabled' || record?.mode === 'selected-workspaces'
      ? record.mode
      : 'enabled';
  const timeout = record?.generationTimeoutMinutes;
  return {
    mode,
    selectedWorkspaceIds: normalizeStringArray(record?.selectedWorkspaceIds),
    generationTimeoutMinutes:
      typeof timeout === 'number' &&
      Number.isFinite(timeout) &&
      Number.isInteger(timeout) &&
      timeout >= 1 &&
      timeout <= 1_440
        ? timeout
        : 30,
  };
}

function normalizeLayoutPreferences(
  data: PreferencesInput,
): NormalizedLayoutPreferences {
  return {
    worktreePanelPercent: clampNumber(
      normalizeFiniteNumber(
        data?.worktreePanelPercent,
        DEFAULT_PREFERENCES.worktreePanelPercent,
      ),
      20,
      65,
    ),
    activityPanelWidthPercent: clampNumber(
      normalizeFiniteNumber(
        data?.activityPanelWidthPercent,
        DEFAULT_PREFERENCES.activityPanelWidthPercent,
      ),
      15,
      40,
    ),
    kanbanWorktreePanelPercent: clampNumber(
      normalizeFiniteNumber(
        data?.kanbanWorktreePanelPercent,
        DEFAULT_PREFERENCES.kanbanWorktreePanelPercent,
      ),
      20,
      65,
    ),
    kanbanActivityPanelWidthPercent: clampNumber(
      normalizeFiniteNumber(
        data?.kanbanActivityPanelWidthPercent,
        DEFAULT_PREFERENCES.kanbanActivityPanelWidthPercent,
      ),
      15,
      40,
    ),
  };
}

function normalizeProviderDefaults(
  data: PreferencesInput,
  validation: ModelSelectionValidation,
): NormalizedProviderDefaults {
  const defaultChatModelByProvider = normalizeModelDefaultsByProvider(
    data?.defaultChatModelByProvider,
    DEFAULT_PREFERENCES.defaultChatModelByProvider,
    validation,
  );
  const defaultWorktreeModelByProvider = normalizeModelDefaultsByProvider(
    data?.defaultWorktreeModelByProvider,
    DEFAULT_PREFERENCES.defaultWorktreeModelByProvider,
    validation,
  );

  return {
    defaultChatProvider: normalizeDefaultProvider(
      data?.defaultChatProvider,
      defaultChatModelByProvider,
      DEFAULT_PREFERENCES.defaultChatProvider,
    ),
    defaultChatModelByProvider,
    defaultWorktreeProvider: normalizeDefaultProvider(
      data?.defaultWorktreeProvider,
      defaultWorktreeModelByProvider,
      DEFAULT_PREFERENCES.defaultWorktreeProvider,
    ),
    defaultWorktreeModelByProvider,
  };
}

function normalizeRuntimeLimits(
  data: PreferencesInput,
): NormalizedRuntimeLimits {
  const scriptTimeoutRaw = data?.scriptTimeoutMinutes;
  const auditRetentionRaw = data?.auditRetentionDays;
  const automationRunRetentionRaw = data?.automationRunRetentionDays;
  const codexIdleTimeoutRaw = data?.codexAppServerIdleTimeoutMinutes;
  const claudeIdleTimeoutRaw = data?.claudeSessionIdleTimeoutMinutes;
  const maxMemoryThresholdBytes = 1024 * 1024 * 1024 * 1024;
  let memoryPressureWarningThresholdBytes = normalizePositiveInteger(
    data?.memoryPressureWarningThresholdBytes,
    DEFAULT_PREFERENCES.memoryPressureWarningThresholdBytes,
    maxMemoryThresholdBytes,
  );
  let memoryPressureCriticalThresholdBytes = normalizePositiveInteger(
    data?.memoryPressureCriticalThresholdBytes,
    DEFAULT_PREFERENCES.memoryPressureCriticalThresholdBytes,
    maxMemoryThresholdBytes,
  );
  if (
    memoryPressureCriticalThresholdBytes <= memoryPressureWarningThresholdBytes
  ) {
    memoryPressureWarningThresholdBytes =
      DEFAULT_PREFERENCES.memoryPressureWarningThresholdBytes;
    memoryPressureCriticalThresholdBytes =
      DEFAULT_PREFERENCES.memoryPressureCriticalThresholdBytes;
  }

  return {
    scriptTimeoutMinutes:
      typeof scriptTimeoutRaw === 'number' && Number.isFinite(scriptTimeoutRaw)
        ? clampNumber(Math.round(scriptTimeoutRaw), 1, 30)
        : DEFAULT_PREFERENCES.scriptTimeoutMinutes,
    auditRetentionDays:
      typeof auditRetentionRaw === 'number' &&
      Number.isFinite(auditRetentionRaw)
        ? clampNumber(Math.round(auditRetentionRaw), 1, 90)
        : DEFAULT_PREFERENCES.auditRetentionDays,
    automationRunRetentionDays:
      typeof automationRunRetentionRaw === 'number' &&
      Number.isFinite(automationRunRetentionRaw)
        ? clampNumber(Math.round(automationRunRetentionRaw), 1, 365)
        : (DEFAULT_PREFERENCES.automationRunRetentionDays ?? 90),
    codexAppServerIdleTimeoutMinutes:
      typeof codexIdleTimeoutRaw === 'number' &&
      Number.isFinite(codexIdleTimeoutRaw)
        ? clampNumber(Math.round(codexIdleTimeoutRaw), 1, 120)
        : DEFAULT_PREFERENCES.codexAppServerIdleTimeoutMinutes,
    claudeSessionIdleTimeoutMinutes:
      typeof claudeIdleTimeoutRaw === 'number' &&
      Number.isFinite(claudeIdleTimeoutRaw)
        ? clampNumber(Math.round(claudeIdleTimeoutRaw), 1, 120)
        : DEFAULT_PREFERENCES.claudeSessionIdleTimeoutMinutes,
    maxActiveChatTurns: normalizeNullablePositiveInteger(
      data?.maxActiveChatTurns,
      DEFAULT_PREFERENCES.maxActiveChatTurns,
      100,
    ),
    maxActivePipelineExecutions: normalizeNullablePositiveInteger(
      data?.maxActivePipelineExecutions,
      DEFAULT_PREFERENCES.maxActivePipelineExecutions,
      100,
    ),
    memoryPressureGuardEnabled: normalizeBoolean(
      data?.memoryPressureGuardEnabled,
      DEFAULT_PREFERENCES.memoryPressureGuardEnabled,
    ),
    bypassCodexAppServerIdleTimeoutUnderCriticalPressure: normalizeBoolean(
      data?.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
      DEFAULT_PREFERENCES.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
    ),
    memoryPressureWarningThresholdBytes,
    memoryPressureCriticalThresholdBytes,
  };
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

/** Narrows persisted unknowns to plain objects without a type assertion. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeNativeProviderAccountRecord(
  value: unknown,
): NativeProviderAccountRecord | undefined {
  if (!isPlainRecord(value)) return undefined;
  const accountKey =
    typeof value.accountKey === 'string' ? value.accountKey.trim() : '';
  if (!accountKey) return undefined;
  const changedAt = value.changedAt;
  const subscriptionRestoredAt = value.subscriptionRestoredAt;
  return {
    accountKey,
    ...(typeof changedAt === 'number' &&
    Number.isFinite(changedAt) &&
    changedAt > 0
      ? { changedAt }
      : {}),
    ...(typeof subscriptionRestoredAt === 'number' &&
    Number.isFinite(subscriptionRestoredAt) &&
    subscriptionRestoredAt > 0
      ? { subscriptionRestoredAt }
      : {}),
  };
}

function normalizeNativeProviderAccounts(
  value: unknown,
): PreferencesData['nativeProviderAccounts'] {
  if (!isPlainRecord(value)) return undefined;
  const accounts: NonNullable<PreferencesData['nativeProviderAccounts']> = {};
  for (const provider of ['claude', 'codex'] as const) {
    const record = normalizeNativeProviderAccountRecord(value[provider]);
    if (record) accounts[provider] = record;
  }
  return Object.keys(accounts).length ? accounts : undefined;
}

function normalizeOptInTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}
function normalizeDataSharingOptInHints(
  value: unknown,
): PreferencesData['dataSharingOptInHints'] {
  if (!isPlainRecord(value)) return undefined;
  const hints: NonNullable<PreferencesData['dataSharingOptInHints']> = {};
  for (const feature of DATA_SHARING_OPT_IN_FEATURES) {
    const entry = value[feature];
    if (!isPlainRecord(entry)) continue;
    const dismissedAt = normalizeOptInTimestamp(entry.dismissedAt);
    if (dismissedAt !== undefined) hints[feature] = { dismissedAt };
  }
  return Object.keys(hints).length ? hints : undefined;
}
function normalizeDataSharingOptInHistory(
  value: unknown,
): PreferencesData['dataSharingOptInHistory'] {
  if (!Array.isArray(value)) return undefined;
  const history: NonNullable<PreferencesData['dataSharingOptInHistory']> = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) continue;
    const enabledAt = normalizeOptInTimestamp(entry.enabledAt);
    if (enabledAt !== undefined && isPlainRecord(entry.sharing)) {
      history.push({
        enabledAt,
        sharing: normalizeTelemetrySharing(entry.sharing),
      });
    }
  }
  return history.length
    ? history.sort((a, b) => a.enabledAt.localeCompare(b.enabledAt))
    : undefined;
}

/**
 * #5222 is not on this base. Retain only its exact compatibility input until
 * its raw-input conversion is integrated; all live checklist state is dropped.
 */
function preserveLegacyPlanModeInput(
  value: unknown,
): LegacyPlanModeChecklistInput | undefined {
  if (!isPlainRecord(value) || !isPlainRecord(value.entries)) return undefined;
  const entry = value.entries['plan-mode'];
  if (!isPlainRecord(entry)) return undefined;
  const completedAt = normalizeIsoTimestamp(entry.completedAt);
  const dismissedAt = normalizeIsoTimestamp(entry.dismissedAt);
  if (completedAt === undefined && dismissedAt === undefined) return undefined;
  return {
    startedAt:
      normalizeIsoTimestamp(value.startedAt) ?? '1970-01-01T00:00:00.000Z',
    entries: {
      'plan-mode': {
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(dismissedAt !== undefined ? { dismissedAt } : {}),
      },
    },
  };
}

function legacyNotificationAnswer(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainRecord(value) || !isPlainRecord(value.entries)) return undefined;
  const answer = value.entries.notifications;
  return isPlainRecord(answer) ? answer : undefined;
}

const ACCOUNT_PROXY_CONNECTION_KINDS: ReadonlySet<string> = new Set([
  'server',
  'local',
  'device',
]);

/** A stored proxy connection, or null when it is missing or malformed. */
function normalizeAccountProxyConnection(
  value: unknown,
): AccountProxyConnection | null {
  if (!isRecord(value)) return null;
  const { id, kind, url } = value;
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9-]{8,64}$/.test(id) ||
    typeof kind !== 'string' ||
    !ACCOUNT_PROXY_CONNECTION_KINDS.has(kind) ||
    typeof url !== 'string'
  ) {
    return null;
  }
  const normalizedUrl = normalizeAccountProxyUrl(url);
  if (!normalizedUrl.ok) return null;
  const connectionKind: AccountProxyConnectionKind =
    kind === 'local' ? 'local' : kind === 'device' ? 'device' : 'server';
  return { id, kind: connectionKind, url: normalizedUrl.url };
}

function normalizePendingInstalledItemUninstalls(
  value: unknown,
): NonNullable<PreferencesData['pendingInstalledItemUninstalls']> {
  if (!Array.isArray(value)) return [];
  const schema = z
    .object({
      target: InstalledItemUninstallTargetSchema,
      refs: z.array(InstalledItemRefSchema),
    })
    .strict();
  return value.flatMap((entry: unknown) => {
    const result = schema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

function normalizeParkedCodexPlugins(
  value: unknown,
): NonNullable<PreferencesData['parkedCodexPlugins']> {
  if (!Array.isArray(value)) return [];
  const records: NonNullable<PreferencesData['parkedCodexPlugins']> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== 'string' ||
      seen.has(entry.key) ||
      parseInstalledItemKey(entry.key)?.kind !== 'plugin' ||
      typeof entry.pluginId !== 'string' ||
      !entry.pluginId ||
      typeof entry.pluginName !== 'string' ||
      !entry.pluginName ||
      !(
        entry.marketplacePath === null ||
        typeof entry.marketplacePath === 'string'
      ) ||
      !(
        entry.remoteMarketplaceName === null ||
        typeof entry.remoteMarketplaceName === 'string'
      ) ||
      (!entry.marketplacePath && !entry.remoteMarketplaceName) ||
      (entry.state !== 'parking' &&
        entry.state !== 'parked' &&
        entry.state !== 'restoring')
    )
      continue;
    records.push({
      key: entry.key,
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      marketplacePath: entry.marketplacePath,
      remoteMarketplaceName: entry.remoteMarketplaceName,
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      ...(typeof entry.sourceDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.sourceDigest)
        ? { sourceDigest: entry.sourceDigest }
        : {}),
      ...(typeof entry.marketplaceSourceDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.marketplaceSourceDigest)
        ? { marketplaceSourceDigest: entry.marketplaceSourceDigest }
        : {}),
      state: entry.state,
    });
    seen.add(entry.key);
  }
  return records;
}

/**
 * The saved chat detail level. Preferences from before the setting existed
 * move over once from the two switches it replaced: "Show only recent steps"
 * on reads as `recent` (it already folded every run), else "Group tool calls"
 * on as `compact`, else the default. The next save writes `chatDetail` and
 * drops the old keys.
 */
function normalizeChatDetailPreference(
  data: Partial<PreferencesData> | Record<string, unknown> | undefined,
): ChatDetail {
  if (data === undefined) return DEFAULT_CHAT_DETAIL;
  if (isChatDetail(data.chatDetail)) return data.chatDetail;
  if (
    'chatLiveStepWindowEnabled' in data &&
    data.chatLiveStepWindowEnabled === true
  )
    return 'recent';
  if (
    'chatGroupToolCallsEnabled' in data &&
    data.chatGroupToolCallsEnabled === true
  )
    return 'compact';
  return DEFAULT_CHAT_DETAIL;
}

export function normalizePreferences(
  data: Partial<PreferencesData> | Record<string, unknown> | undefined,
  modelSelectionValidation: ModelSelectionValidation = 'runtime',
): PreferencesData {
  const layout = normalizeLayoutPreferences(data);
  const providerDefaults = normalizeProviderDefaults(
    data,
    modelSelectionValidation,
  );
  const providerModelConfigDefaults = normalizeProviderModelConfigDefaults(
    data?.providerModelConfigDefaults,
    data?.codexFastModeDefaultEnabled,
  );
  const runtimeLimits = normalizeRuntimeLimits(data);
  const onboardingCompleted = normalizeStringArray(data?.onboardingCompleted);
  // Migrate the raw compatibility entry before checklist normalization can
  // discard it. A persisted marker, including a reset, always wins.
  const planModeHint =
    data?.planModeHint === undefined
      ? migrateLegacyPlanModeHintRecord(data?.homeOnboardingSuggestions)
      : normalizePlanModeHintRecord(data.planModeHint);
  const githubStarPrompt =
    data?.githubStarPrompt === undefined
      ? { version: 1 as const, promptsSent: 0 }
      : normalizeGitHubStarPromptRecord(data.githubStarPrompt);
  const homeOnboardingSuggestions = preserveLegacyPlanModeInput(
    data?.homeOnboardingSuggestions,
  );
  const nativeProviderAccounts = normalizeNativeProviderAccounts(
    data?.nativeProviderAccounts,
  );
  const notificationAnswer = legacyNotificationAnswer(
    data?.homeOnboardingSuggestions,
  );
  const legacyNotificationAnswerTimestamps = [
    normalizeOptInTimestamp(notificationAnswer?.completedAt),
    normalizeOptInTimestamp(notificationAnswer?.dismissedAt),
  ].filter((value): value is string => value !== undefined);
  legacyNotificationAnswerTimestamps.sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  );
  const osNotificationOfferAnsweredAt =
    normalizeOptInTimestamp(data?.osNotificationOfferAnsweredAt) ??
    legacyNotificationAnswerTimestamps[0];
  const dataSharingOptInHints = normalizeDataSharingOptInHints(
    data?.dataSharingOptInHints,
  );
  const dataSharingOptInHistory = normalizeDataSharingOptInHistory(
    data?.dataSharingOptInHistory,
  );
  const prefixMode = isBranchNamePrefixMode(data?.branchNamePrefixMode)
    ? data.branchNamePrefixMode
    : DEFAULT_PREFERENCES.branchNamePrefixMode;
  const summaryModel = normalizeUserSelectedModel(
    data?.summaryModel,
    data?.summaryModelSetByUser,
    { stored: DEFAULT_SUMMARY_MODEL, providerAware: defaultSummaryModel },
    modelSelectionValidation,
  );
  const localMemoryModel = normalizeUserSelectedModel(
    data?.localMemoryModel,
    data?.localMemoryModelSetByUser,
    {
      stored: DEFAULT_LOCAL_MEMORY_MODEL,
      providerAware: defaultLocalMemoryModel,
    },
    modelSelectionValidation,
    // Memory runs refuse an unavailable chosen model (see
    // resolveLocalMemoryHelperModel) instead of sending saved memory to the
    // default's provider.
    { keepUnavailableChoice: true },
  );
  const handoffSummaryModel = normalizePersistableModelSelectionOrDefault(
    data?.handoffSummaryModel,
    DEFAULT_HANDOFF_SUMMARY_MODEL,
    // Keep an unavailable saved local choice. Changed runtime writes are
    // rejected below instead of substituting a cloud default.
    'persisted',
  );
  const handoffThinking = normalizeThinkingLevel(
    data?.handoffSummaryThinkingLevel,
    'off',
  );

  return {
    cursorEnabled: data?.cursorEnabled === true,
    copilotEnabled: data?.copilotEnabled === true,
    opencodeEnabled: data?.opencodeEnabled === true,
    accountProxyEnabled: data?.accountProxyEnabled === true,
    accountProxyConnection: normalizeAccountProxyConnection(
      data?.accountProxyConnection,
    ),
    accountProxyKeepChatOnOneAccount:
      data?.accountProxyKeepChatOnOneAccount !== false,
    accountProxyRouteClaude: data?.accountProxyRouteClaude !== false,
    accountProxyRouteCodex: data?.accountProxyRouteCodex !== false,
    accountProxyLocalStartWithApp:
      data?.accountProxyLocalStartWithApp !== false,
    ...(isAccountProxyRoutingStrategy(data?.accountProxyLocalRoutingStrategy)
      ? {
          accountProxyLocalRoutingStrategy:
            data.accountProxyLocalRoutingStrategy,
        }
      : {}),
    copilotAccount:
      isRecord(data?.copilotAccount) &&
      typeof data.copilotAccount.login === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(data.copilotAccount.login) &&
      typeof data.copilotAccount.host === 'string' &&
      /^https:\/\/(github\.com|[a-z0-9-]+\.ghe\.com)$/.test(
        data.copilotAccount.host,
      )
        ? { login: data.copilotAccount.login, host: data.copilotAccount.host }
        : undefined,
    orgProjectDefaultDestinationRoot:
      typeof data?.orgProjectDefaultDestinationRoot === 'string'
        ? data.orgProjectDefaultDestinationRoot.trim()
        : undefined,
    orgProjectCloneProtocol:
      data?.orgProjectCloneProtocol === 'ssh' ? 'ssh' : 'https',
    cursorAgentPath:
      typeof data?.cursorAgentPath === 'string'
        ? data.cursorAgentPath.trim()
        : '',
    ...(data?.chatWidth === 'full' ? { chatWidth: 'full' as const } : {}),
    workspaceDefaultLayoutMode: isWorkspaceLayoutMode(
      data?.workspaceDefaultLayoutMode,
    )
      ? data.workspaceDefaultLayoutMode
      : DEFAULT_PREFERENCES.workspaceDefaultLayoutMode,
    navigationMode: isNavigationMode(data?.navigationMode)
      ? data.navigationMode
      : DEFAULT_PREFERENCES.navigationMode,
    worktreePanelPercent: layout.worktreePanelPercent,
    activityPanelExpanded:
      typeof data?.activityPanelExpanded === 'boolean'
        ? data.activityPanelExpanded
        : DEFAULT_PREFERENCES.activityPanelExpanded,
    activityPanelWidthPercent: layout.activityPanelWidthPercent,
    kanbanWorktreePanelPercent: layout.kanbanWorktreePanelPercent,
    kanbanActivityPanelExpanded:
      typeof data?.kanbanActivityPanelExpanded === 'boolean'
        ? data.kanbanActivityPanelExpanded
        : DEFAULT_PREFERENCES.kanbanActivityPanelExpanded,
    kanbanActivityPanelWidthPercent: layout.kanbanActivityPanelWidthPercent,
    kanbanChatPanelVisible:
      typeof data?.kanbanChatPanelVisible === 'boolean'
        ? data.kanbanChatPanelVisible
        : DEFAULT_PREFERENCES.kanbanChatPanelVisible,
    pipelineChatPanelVisible:
      typeof data?.pipelineChatPanelVisible === 'boolean'
        ? data.pipelineChatPanelVisible
        : DEFAULT_PREFERENCES.pipelineChatPanelVisible,
    pipelineChatPanelWidthPercent: clampNumber(
      normalizeFiniteNumber(
        data?.pipelineChatPanelWidthPercent,
        DEFAULT_PREFERENCES.pipelineChatPanelWidthPercent ?? 30,
      ),
      20,
      65,
    ),
    sidebarCollapsed:
      typeof data?.sidebarCollapsed === 'boolean'
        ? data.sidebarCollapsed
        : DEFAULT_PREFERENCES.sidebarCollapsed,
    sidebarProjectSortMode:
      data?.sidebarProjectSortMode === 'last-updated'
        ? 'last-updated'
        : 'manual',
    sidebarWidth: clampNumber(
      normalizeFiniteNumber(
        data?.sidebarWidth,
        DEFAULT_PREFERENCES.sidebarWidth,
      ),
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
    ),
    sidebarCodeSectionCollapsed:
      typeof data?.sidebarCodeSectionCollapsed === 'boolean'
        ? data.sidebarCodeSectionCollapsed
        : DEFAULT_PREFERENCES.sidebarCodeSectionCollapsed,
    sidebarCoworkSectionCollapsed:
      typeof data?.sidebarCoworkSectionCollapsed === 'boolean'
        ? data.sidebarCoworkSectionCollapsed
        : DEFAULT_PREFERENCES.sidebarCoworkSectionCollapsed,
    sidebarNavLayout:
      typeof data?.sidebarNavLayout === 'object' &&
      data?.sidebarNavLayout !== null
        ? reconcileSidebarNavLayout(data.sidebarNavLayout)
        : reconcileSidebarNavLayout(undefined),
    branchNamePrefixMode: prefixMode,
    branchNameCustomPrefix:
      typeof data?.branchNameCustomPrefix === 'string'
        ? data.branchNameCustomPrefix
        : DEFAULT_PREFERENCES.branchNameCustomPrefix,
    deleteBranchOnArchive:
      typeof data?.deleteBranchOnArchive === 'boolean'
        ? data.deleteBranchOnArchive
        : DEFAULT_PREFERENCES.deleteBranchOnArchive,
    archiveOnMerge:
      typeof data?.archiveOnMerge === 'boolean'
        ? data.archiveOnMerge
        : DEFAULT_PREFERENCES.archiveOnMerge,
    groupChildBranchesWithBase:
      typeof data?.groupChildBranchesWithBase === 'boolean'
        ? data.groupChildBranchesWithBase
        : DEFAULT_PREFERENCES.groupChildBranchesWithBase,
    defaultChatProvider: providerDefaults.defaultChatProvider,
    defaultChatModelByProvider: providerDefaults.defaultChatModelByProvider,
    defaultWorktreeProvider: providerDefaults.defaultWorktreeProvider,
    defaultWorktreeModelByProvider:
      providerDefaults.defaultWorktreeModelByProvider,
    approvalDefaults: normalizeApprovalDefaults(
      data?.approvalDefaults,
      DEFAULT_PREFERENCES.approvalDefaults,
    ),
    globalApprovalRules: normalizeApprovalRules(data?.globalApprovalRules),
    approvalsUpgradeNoticeDismissed:
      typeof data?.approvalsUpgradeNoticeDismissed === 'boolean'
        ? data.approvalsUpgradeNoticeDismissed
        : DEFAULT_PREFERENCES.approvalsUpgradeNoticeDismissed,
    onboardingTipsDismissed: normalizeOnboardingTipDismissals(
      data?.onboardingTipsDismissed,
    ),
    ...(isBillingLane(data?.lastResolvedDefaultLane)
      ? { lastResolvedDefaultLane: data.lastResolvedDefaultLane }
      : {}),
    ...normalizeLastResolvedLaneByScope(
      data?.lastResolvedDefaultLaneByScope,
      data?.lastResolvedDefaultLane,
    ),
    summaryModel: summaryModel.model,
    summaryModelSetByUser: summaryModel.setByUser,
    summaryThinkingLevel: normalizeThinkingLevel(
      data?.summaryThinkingLevel,
      DEFAULT_PREFERENCES.summaryThinkingLevel,
    ),
    handoffSummaryModel,
    handoffSummaryThinkingLevel: resolveKnownModel(handoffSummaryModel)
      ? clampThinkingLevelForModel(handoffThinking, handoffSummaryModel)
      : handoffThinking,
    worktreeSummaryEnabled:
      typeof data?.worktreeSummaryEnabled === 'boolean'
        ? data.worktreeSummaryEnabled
        : DEFAULT_PREFERENCES.worktreeSummaryEnabled,
    worktreeSummaryModel: normalizePersistableModelSelectionOrDefault(
      data?.worktreeSummaryModel,
      DEFAULT_PREFERENCES.worktreeSummaryModel,
      modelSelectionValidation,
    ),
    worktreeSummaryThinkingLevel: normalizeThinkingLevel(
      data?.worktreeSummaryThinkingLevel,
      DEFAULT_PREFERENCES.worktreeSummaryThinkingLevel,
    ),
    planDiagramModel: normalizePersistableModelSelectionOrDefault(
      data?.planDiagramModel,
      DEFAULT_PREFERENCES.planDiagramModel,
      modelSelectionValidation,
    ),
    planDiagramThinkingLevel: normalizeThinkingLevel(
      data?.planDiagramThinkingLevel,
      DEFAULT_PREFERENCES.planDiagramThinkingLevel,
    ),
    codeReviewModel: normalizePersistableModelSelectionOrDefault(
      data?.codeReviewModel,
      DEFAULT_PREFERENCES.codeReviewModel,
      modelSelectionValidation,
    ),
    codeReviewThinkingLevel: normalizeThinkingLevel(
      data?.codeReviewThinkingLevel,
      DEFAULT_PREFERENCES.codeReviewThinkingLevel,
    ),
    prGenerationModel: normalizePersistableModelSelectionOrDefault(
      data?.prGenerationModel,
      DEFAULT_PREFERENCES.prGenerationModel,
      modelSelectionValidation,
    ),
    prGenerationThinkingLevel: normalizeThinkingLevel(
      data?.prGenerationThinkingLevel,
    ),
    prInstructions:
      typeof data?.prInstructions === 'string'
        ? data.prInstructions
        : DEFAULT_PREFERENCES.prInstructions,
    prInstructionMode: isPrInstructionMode(data?.prInstructionMode)
      ? data.prInstructionMode
      : DEFAULT_PREFERENCES.prInstructionMode,
    commitGenerationModel: normalizePersistableModelSelectionOrDefault(
      data?.commitGenerationModel,
      DEFAULT_PREFERENCES.commitGenerationModel,
      modelSelectionValidation,
    ),
    commitGenerationThinkingLevel: normalizeThinkingLevel(
      data?.commitGenerationThinkingLevel,
      DEFAULT_PREFERENCES.commitGenerationThinkingLevel,
    ),
    commitInstructions:
      typeof data?.commitInstructions === 'string'
        ? data.commitInstructions
        : DEFAULT_PREFERENCES.commitInstructions,
    commitInstructionMode: isPrInstructionMode(data?.commitInstructionMode)
      ? data.commitInstructionMode
      : DEFAULT_PREFERENCES.commitInstructionMode,
    branchNamingModel: normalizePersistableModelSelectionOrDefault(
      data?.branchNamingModel,
      DEFAULT_PREFERENCES.branchNamingModel,
      modelSelectionValidation,
    ),
    branchNamingThinkingLevel: normalizeThinkingLevel(
      data?.branchNamingThinkingLevel,
      DEFAULT_PREFERENCES.branchNamingThinkingLevel,
    ),
    branchNamingInstructions:
      typeof data?.branchNamingInstructions === 'string'
        ? data.branchNamingInstructions
        : DEFAULT_PREFERENCES.branchNamingInstructions,
    globalInstructions: normalizeGlobalInstructionsConfig(
      data?.globalInstructions,
    ),
    pipelineAdvisorEnabled:
      typeof data?.pipelineAdvisorEnabled === 'boolean'
        ? data.pipelineAdvisorEnabled
        : DEFAULT_PREFERENCES.pipelineAdvisorEnabled,
    // This intentionally uses a new key instead of reinterpreting the legacy
    // opt-in `orgMemoryEnabled` preference. Existing installs therefore adopt
    // the new enabled-by-default behavior once, while a subsequent opt-out is
    // persisted normally under the new key.
    orgMemoryInjectionEnabled:
      typeof data?.orgMemoryInjectionEnabled === 'boolean'
        ? data.orgMemoryInjectionEnabled
        : DEFAULT_PREFERENCES.orgMemoryInjectionEnabled,
    localMemoryEnabled:
      typeof data?.localMemoryEnabled === 'boolean'
        ? data.localMemoryEnabled
        : DEFAULT_PREFERENCES.localMemoryEnabled,
    localMemoryEnabledSetByUser:
      typeof data?.localMemoryEnabledSetByUser === 'boolean'
        ? data.localMemoryEnabledSetByUser
        : DEFAULT_PREFERENCES.localMemoryEnabledSetByUser,
    localMemoryModel: localMemoryModel.model,
    localMemoryModelSetByUser: localMemoryModel.setByUser,
    localMemoryThinkingLevel: normalizeThinkingLevel(
      data?.localMemoryThinkingLevel,
      DEFAULT_PREFERENCES.localMemoryThinkingLevel,
    ),
    pipelineAdvisorModel: normalizePersistablePipelineAdvisorModelOrDefault(
      data?.pipelineAdvisorModel,
      DEFAULT_PREFERENCES.pipelineAdvisorModel,
      modelSelectionValidation,
    ),
    pipelineAdvisorThinkingLevel: normalizeThinkingLevel(
      data?.pipelineAdvisorThinkingLevel,
      DEFAULT_PREFERENCES.pipelineAdvisorThinkingLevel,
    ),
    disabledPipelineIds: normalizeStringArray(data?.disabledPipelineIds),
    appAdvisorModel: normalizePersistableModelSelectionOrDefault(
      data?.appAdvisorModel,
      DEFAULT_PREFERENCES.appAdvisorModel,
      modelSelectionValidation,
    ),
    appAdvisorThinkingLevel: normalizeThinkingLevel(
      data?.appAdvisorThinkingLevel,
      DEFAULT_PREFERENCES.appAdvisorThinkingLevel,
    ),
    cronGenerationModel: normalizePersistablePipelineAdvisorModelOrDefault(
      data?.cronGenerationModel,
      DEFAULT_PREFERENCES.cronGenerationModel,
      modelSelectionValidation,
    ),
    cronGenerationThinkingLevel: normalizeThinkingLevel(
      data?.cronGenerationThinkingLevel,
      DEFAULT_PREFERENCES.cronGenerationThinkingLevel,
    ),
    ifCommandGenerationModel: normalizePersistablePipelineAdvisorModelOrDefault(
      data?.ifCommandGenerationModel,
      DEFAULT_PREFERENCES.ifCommandGenerationModel,
      modelSelectionValidation,
    ),
    ifCommandGenerationThinkingLevel: normalizeThinkingLevel(
      data?.ifCommandGenerationThinkingLevel,
      DEFAULT_PREFERENCES.ifCommandGenerationThinkingLevel,
    ),
    splitPrThresholdLines: clampNumber(
      normalizeFiniteNumber(
        data?.splitPrThresholdLines,
        DEFAULT_PREFERENCES.splitPrThresholdLines,
      ),
      50,
      100_000,
    ),
    splitPrEnabled: normalizeBoolean(
      data?.splitPrEnabled,
      DEFAULT_PREFERENCES.splitPrEnabled,
    ),
    splitPrPlannerModel: normalizePersistableModelSelectionOrDefault(
      data?.splitPrPlannerModel,
      DEFAULT_PREFERENCES.splitPrPlannerModel,
      modelSelectionValidation,
    ),
    splitPrPlannerThinkingLevel: normalizeThinkingLevel(
      data?.splitPrPlannerThinkingLevel,
      DEFAULT_PREFERENCES.splitPrPlannerThinkingLevel,
    ),
    disabledInstalledItems: normalizeDisabledInstalledItems(
      data?.disabledInstalledItems,
    ),
    parkedCodexPlugins: normalizeParkedCodexPlugins(data?.parkedCodexPlugins),
    pendingInstalledItemUninstalls: normalizePendingInstalledItemUninstalls(
      data?.pendingInstalledItemUninstalls,
    ),
    globalPluginSelections: excludeDisabledInstalledItems(
      normalizeChatTabPluginSelections(data?.globalPluginSelections),
      normalizeDisabledInstalledItems(data?.disabledInstalledItems),
    ),
    ...(Array.isArray(data?.initializedCuratedPluginDefaults)
      ? {
          initializedCuratedPluginDefaults: normalizeStringArray(
            data.initializedCuratedPluginDefaults,
          ),
        }
      : {}),
    appAdvisorPluginSelections: normalizeChatTabPluginSelections(
      data?.appAdvisorPluginSelections,
    ),
    pipelineEditorPluginSelections: normalizeChatTabPluginSelections(
      data?.pipelineEditorPluginSelections,
    ),
    appAdvisorDialogBounds: normalizeAppAdvisorDialogBounds(
      data?.appAdvisorDialogBounds,
    ),
    // Optional: only persisted once the user has toggled the App Advisor
    // popout nav (absent = expanded default).
    ...(typeof data?.appAdvisorNavCollapsed === 'boolean'
      ? { appAdvisorNavCollapsed: data.appAdvisorNavCollapsed }
      : {}),
    codexMultiAgentAppAdvisorEnabled: normalizeBoolean(
      data?.codexMultiAgentAppAdvisorEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentAppAdvisorEnabled,
    ),
    providerModelConfigDefaults,
    codexFastModeDefaultEnabled:
      providerModelConfigDefaults.codex?.fastMode ?? false,
    branchNamingPluginSelections: normalizeChatTabPluginSelections(
      data?.branchNamingPluginSelections,
    ),
    commitGenerationPluginSelections: normalizeChatTabPluginSelections(
      data?.commitGenerationPluginSelections,
    ),
    prGenerationPluginSelections: normalizeChatTabPluginSelections(
      data?.prGenerationPluginSelections,
    ),
    worktreeSummaryPluginSelections: normalizeChatTabPluginSelections(
      data?.worktreeSummaryPluginSelections,
    ),
    codexCompatDisabledPlugins: normalizeCodexCompatDisabledPlugins(
      data?.codexCompatDisabledPlugins,
    ),
    branchDisplayMappings: normalizeBranchDisplayMappings(
      data?.branchDisplayMappings,
    ),
    reviewCommitMessage:
      typeof data?.reviewCommitMessage === 'boolean'
        ? data.reviewCommitMessage
        : DEFAULT_PREFERENCES.reviewCommitMessage,
    agentRebaseResolutionEnabled:
      typeof data?.agentRebaseResolutionEnabled === 'boolean'
        ? data.agentRebaseResolutionEnabled
        : DEFAULT_PREFERENCES.agentRebaseResolutionEnabled,
    agentRebaseResolutionModel: normalizePersistableModelSelectionOrDefault(
      data?.agentRebaseResolutionModel,
      DEFAULT_PREFERENCES.agentRebaseResolutionModel,
      modelSelectionValidation,
    ),
    agentRebaseResolutionThinkingLevel: normalizeOptionalThinkingLevel(
      data?.agentRebaseResolutionThinkingLevel,
    ),
    mergeQueueAgentHandling: isMergeQueueAgentHandling(
      data?.mergeQueueAgentHandling,
    )
      ? data.mergeQueueAgentHandling
      : DEFAULT_PREFERENCES.mergeQueueAgentHandling,
    rtkEnabled:
      typeof data?.rtkEnabled === 'boolean'
        ? data.rtkEnabled
        : DEFAULT_PREFERENCES.rtkEnabled,
    autoRetryTransientErrorsChats:
      typeof data?.autoRetryTransientErrorsChats === 'boolean'
        ? data.autoRetryTransientErrorsChats
        : DEFAULT_PREFERENCES.autoRetryTransientErrorsChats,
    autoRetryTransientErrorsPipelines:
      typeof data?.autoRetryTransientErrorsPipelines === 'boolean'
        ? data.autoRetryTransientErrorsPipelines
        : DEFAULT_PREFERENCES.autoRetryTransientErrorsPipelines,
    scriptTimeoutMinutes: runtimeLimits.scriptTimeoutMinutes,
    codexAppServerIdleTimeoutMinutes:
      runtimeLimits.codexAppServerIdleTimeoutMinutes,
    claudeSessionIdleTimeoutMinutes:
      runtimeLimits.claudeSessionIdleTimeoutMinutes,
    defaultChatInterfaceMode: isChatInterfaceMode(
      data?.defaultChatInterfaceMode,
    )
      ? data.defaultChatInterfaceMode
      : DEFAULT_PREFERENCES.defaultChatInterfaceMode,
    defaultStandaloneChatInterfaceMode: isChatInterfaceMode(
      data?.defaultStandaloneChatInterfaceMode,
    )
      ? data.defaultStandaloneChatInterfaceMode
      : DEFAULT_PREFERENCES.defaultStandaloneChatInterfaceMode,
    defaultAppAdvisorInterfaceMode: isChatInterfaceMode(
      data?.defaultAppAdvisorInterfaceMode,
    )
      ? data.defaultAppAdvisorInterfaceMode
      : DEFAULT_PREFERENCES.defaultAppAdvisorInterfaceMode,
    preventClaudeNativeCaffeinate: normalizeBoolean(
      data?.preventClaudeNativeCaffeinate,
      DEFAULT_PREFERENCES.preventClaudeNativeCaffeinate,
    ),
    claudeMaxTurns: normalizeClaudeMaxTurns(data?.claudeMaxTurns),
    maxActiveChatTurns: runtimeLimits.maxActiveChatTurns,
    maxActivePipelineExecutions: runtimeLimits.maxActivePipelineExecutions,
    canopyBackgroundProcessesMode: isBackgroundProcessMode(
      data?.canopyBackgroundProcessesMode,
    )
      ? data.canopyBackgroundProcessesMode
      : DEFAULT_PREFERENCES.canopyBackgroundProcessesMode,
    pipelinesMode: isBackgroundProcessMode(data?.pipelinesMode)
      ? data.pipelinesMode
      : DEFAULT_PREFERENCES.pipelinesMode,
    workerConcurrencyLimit:
      typeof data?.workerConcurrencyLimit === 'number' &&
      Number.isFinite(data.workerConcurrencyLimit)
        ? clampNumber(Math.round(data.workerConcurrencyLimit), 1, 16)
        : DEFAULT_PREFERENCES.workerConcurrencyLimit,
    memoryPressureGuardEnabled: runtimeLimits.memoryPressureGuardEnabled,
    bypassCodexAppServerIdleTimeoutUnderCriticalPressure:
      runtimeLimits.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
    memoryPressureWarningThresholdBytes:
      runtimeLimits.memoryPressureWarningThresholdBytes,
    memoryPressureCriticalThresholdBytes:
      runtimeLimits.memoryPressureCriticalThresholdBytes,
    memoryDiagnosticsEnabled:
      typeof data?.memoryDiagnosticsEnabled === 'boolean'
        ? data.memoryDiagnosticsEnabled
        : DEFAULT_PREFERENCES.memoryDiagnosticsEnabled,
    keepSystemAwakeWhileAgentsActive:
      typeof data?.keepSystemAwakeWhileAgentsActive === 'boolean'
        ? data.keepSystemAwakeWhileAgentsActive
        : DEFAULT_PREFERENCES.keepSystemAwakeWhileAgentsActive,
    managedDelegationMaxDepth: normalizeManagedDelegationMaxDepth(
      data?.managedDelegationMaxDepth,
    ),
    managedDelegationMaxConcurrent: normalizeManagedDelegationMaxConcurrent(
      data?.managedDelegationMaxConcurrent,
    ),
    managedDelegationLifetimeLimit: normalizeManagedDelegationLifetimeLimit(
      data?.managedDelegationLifetimeLimit,
    ),
    ...(data?.managedDelegationMode === undefined
      ? {}
      : {
          managedDelegationMode: normalizeManagedDelegationMode(
            data.managedDelegationMode,
          ),
        }),
    codexMultiAgentWorktreeChatsEnabled: normalizeBoolean(
      data?.codexMultiAgentWorktreeChatsEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentWorktreeChatsEnabled,
    ),
    codexMultiAgentStandaloneChatsEnabled: normalizeBoolean(
      data?.codexMultiAgentStandaloneChatsEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentStandaloneChatsEnabled,
    ),
    codexMaxConcurrentSubagents: normalizeCodexMaxConcurrentSubagents(
      data?.codexMaxConcurrentSubagents,
    ),
    codexMultiAgentPipelinesEnabled: normalizeBoolean(
      data?.codexMultiAgentPipelinesEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentPipelinesEnabled,
    ),
    deferredToolsWorktreeChatsEnabled: normalizeBoolean(
      data?.deferredToolsWorktreeChatsEnabled,
      DEFAULT_PREFERENCES.deferredToolsWorktreeChatsEnabled ?? true,
    ),
    deferredToolsStandaloneChatsEnabled: normalizeBoolean(
      data?.deferredToolsStandaloneChatsEnabled,
      DEFAULT_PREFERENCES.deferredToolsStandaloneChatsEnabled ?? true,
    ),
    deferredToolsAppAdvisorEnabled: normalizeBoolean(
      data?.deferredToolsAppAdvisorEnabled,
      DEFAULT_PREFERENCES.deferredToolsAppAdvisorEnabled ?? true,
    ),
    deferredToolsPipelineAssistantEnabled: normalizeBoolean(
      data?.deferredToolsPipelineAssistantEnabled,
      DEFAULT_PREFERENCES.deferredToolsPipelineAssistantEnabled ?? true,
    ),
    lastOpenApp:
      typeof data?.lastOpenApp === 'string'
        ? data.lastOpenApp
        : DEFAULT_PREFERENCES.lastOpenApp,
    disabledOpenApps: Array.isArray(data?.disabledOpenApps)
      ? data.disabledOpenApps.filter(
          (v: unknown): v is string => typeof v === 'string',
        )
      : DEFAULT_PREFERENCES.disabledOpenApps,
    lastSelectedWorktreeProjectId:
      typeof data?.lastSelectedWorktreeProjectId === 'string'
        ? data.lastSelectedWorktreeProjectId
        : DEFAULT_PREFERENCES.lastSelectedWorktreeProjectId,
    lastSelectedWorktreeId:
      typeof data?.lastSelectedWorktreeId === 'string'
        ? data.lastSelectedWorktreeId
        : DEFAULT_PREFERENCES.lastSelectedWorktreeId,
    lastActiveContext: normalizeLastActiveContext(data?.lastActiveContext),
    executionDetailViewMode:
      data?.executionDetailViewMode === 'list' ||
      data?.executionDetailViewMode === 'flow'
        ? data.executionDetailViewMode
        : DEFAULT_PREFERENCES.executionDetailViewMode,
    worktreeViewMode:
      data?.worktreeViewMode === 'list' || data?.worktreeViewMode === 'kanban'
        ? data.worktreeViewMode
        : DEFAULT_PREFERENCES.worktreeViewMode,
    worktreeFilterHiddenWorkspaceIds: Array.isArray(
      data?.worktreeFilterHiddenWorkspaceIds,
    )
      ? data.worktreeFilterHiddenWorkspaceIds.filter(
          (v: unknown): v is string => typeof v === 'string',
        )
      : DEFAULT_PREFERENCES.worktreeFilterHiddenWorkspaceIds,
    auditRetentionDays: runtimeLimits.auditRetentionDays,
    automationRunRetentionDays: runtimeLimits.automationRunRetentionDays,
    theme: isThemeName(data?.theme) ? data.theme : DEFAULT_PREFERENCES.theme,
    colorMode: isColorMode(data?.colorMode)
      ? data.colorMode
      : DEFAULT_PREFERENCES.colorMode,
    sidebarAppearance: isSidebarAppearance(data?.sidebarAppearance)
      ? data.sidebarAppearance
      : DEFAULT_PREFERENCES.sidebarAppearance,
    worktreeDiffStatsStyle: isWorktreeDiffStatsStyle(
      data?.worktreeDiffStatsStyle,
    )
      ? data.worktreeDiffStatsStyle
      : DEFAULT_PREFERENCES.worktreeDiffStatsStyle,
    scrollbarBehavior: isScrollbarBehavior(data?.scrollbarBehavior)
      ? data.scrollbarBehavior
      : DEFAULT_PREFERENCES.scrollbarBehavior,
    singleDollarMath:
      typeof data?.singleDollarMath === 'boolean'
        ? data.singleDollarMath
        : DEFAULT_PREFERENCES.singleDollarMath,
    linearChatEnrichmentMode: isChatEnrichmentMode(
      data?.linearChatEnrichmentMode,
    )
      ? data.linearChatEnrichmentMode
      : DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
    githubChatEnrichmentMode: isChatEnrichmentMode(
      data?.githubChatEnrichmentMode,
    )
      ? data.githubChatEnrichmentMode
      : DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
    // Clamped and snapped through the shared helper the Display slider and
    // the View-menu zoom items also use, so no surface can offer a scale the
    // store would rewrite behind it.
    uiScale: clampUiScale(
      typeof data?.uiScale === 'number' ? data.uiScale : undefined,
    ),
    // Always a boolean, on unless the user turned it off: preferences written
    // before the setting existed keep agents recording in the Ledger.
    ledgerAgentRecordingEnabled:
      typeof data?.ledgerAgentRecordingEnabled === 'boolean'
        ? data.ledgerAgentRecordingEnabled
        : DEFAULT_PREFERENCES.ledgerAgentRecordingEnabled,
    // On unless the user turned it off, as for preferences written before
    // the setting existed.
    suggestions: normalizeSuggestionsState(
      data?.suggestions,
      data?.repeatTaskAutomationSuggestionsEnabled,
    ),
    ...(typeof data?.repeatTaskAutomationSuggestionsEnabled === 'boolean'
      ? {
          repeatTaskAutomationSuggestionsEnabled:
            data.repeatTaskAutomationSuggestionsEnabled,
        }
      : {}),
    skillSuggestionsEnabled:
      typeof data?.skillSuggestionsEnabled === 'boolean'
        ? data.skillSuggestionsEnabled
        : DEFAULT_PREFERENCES.skillSuggestionsEnabled,
    // Off unless explicitly on; the next launch moves storage to match.
    rendererCodeCacheSchemeEnabled:
      data?.rendererCodeCacheSchemeEnabled === true,
    chatDetail: normalizeChatDetailPreference(data),
    // On unless the user turned it off.
    remoteControlEnabled: data?.remoteControlEnabled !== false,
    windowBounds: normalizeWindowBounds(data?.windowBounds),
    windowMaximized:
      typeof data?.windowMaximized === 'boolean'
        ? data.windowMaximized
        : DEFAULT_PREFERENCES.windowMaximized,
    windowFullScreen:
      typeof data?.windowFullScreen === 'boolean'
        ? data.windowFullScreen
        : DEFAULT_PREFERENCES.windowFullScreen,
    ollamaServerPort:
      typeof data?.ollamaServerPort === 'number' &&
      Number.isFinite(data.ollamaServerPort) &&
      data.ollamaServerPort > 0 &&
      data.ollamaServerPort <= 65535
        ? Math.round(data.ollamaServerPort)
        : DEFAULT_PREFERENCES.ollamaServerPort,
    // Transport contract: minimal shape normalization so the field is always
    // present. The full migration behavior (Windows/older-macOS compatibility,
    // legacy value mapping) is owned by the backend plan.
    ollamaConnectionMode:
      data?.ollamaConnectionMode === 'managed' ||
      data?.ollamaConnectionMode === 'manual'
        ? data.ollamaConnectionMode
        : DEFAULT_PREFERENCES.ollamaConnectionMode,
    ollamaExecutablePath: normalizeString(
      data?.ollamaExecutablePath,
      DEFAULT_PREFERENCES.ollamaExecutablePath,
    ),
    mcpProxyPort:
      typeof data?.mcpProxyPort === 'number' &&
      Number.isFinite(data.mcpProxyPort) &&
      data.mcpProxyPort > 0 &&
      data.mcpProxyPort <= 65535
        ? Math.round(data.mcpProxyPort)
        : DEFAULT_PREFERENCES.mcpProxyPort,
    hideAnthropicNav:
      typeof data?.hideAnthropicNav === 'boolean'
        ? data.hideAnthropicNav
        : DEFAULT_PREFERENCES.hideAnthropicNav,
    aiCreditsRoutingMode: isAiCreditsRoutingMode(data?.aiCreditsRoutingMode)
      ? data.aiCreditsRoutingMode
      : DEFAULT_PREFERENCES.aiCreditsRoutingMode,
    // Intentionally NOT defaulted: unset must stay unset so users who never
    // touch the "Use AI Credits" toggle preserve today's seeding behavior.
    lastChatBillingFramework: isChatBillingFramework(
      data?.lastChatBillingFramework,
    )
      ? data.lastChatBillingFramework
      : undefined,
    fileAutoSave:
      typeof data?.fileAutoSave === 'boolean'
        ? data.fileAutoSave
        : DEFAULT_PREFERENCES.fileAutoSave,
    inAppBrowserLocalServersOnly:
      typeof data?.inAppBrowserLocalServersOnly === 'boolean'
        ? data.inAppBrowserLocalServersOnly
        : DEFAULT_PREFERENCES.inAppBrowserLocalServersOnly,
    inAppBrowserSearchEngineId:
      typeof data?.inAppBrowserSearchEngineId === 'string' &&
      data.inAppBrowserSearchEngineId.trim().length > 0
        ? data.inAppBrowserSearchEngineId.trim()
        : DEFAULT_PREFERENCES.inAppBrowserSearchEngineId,
    inAppBrowserCustomSearchEngines: normalizeCustomBrowserSearchEngines(
      data?.inAppBrowserCustomSearchEngines,
    ),
    openAppLinksInBuiltInBrowser:
      typeof data?.openAppLinksInBuiltInBrowser === 'boolean'
        ? data.openAppLinksInBuiltInBrowser
        : DEFAULT_PREFERENCES.openAppLinksInBuiltInBrowser,
    useAsSystemDefaultBrowser:
      typeof data?.useAsSystemDefaultBrowser === 'boolean'
        ? data.useAsSystemDefaultBrowser
        : DEFAULT_PREFERENCES.useAsSystemDefaultBrowser,
    inAppNotifications: normalizeInAppNotifications(
      data?.inAppNotifications,
      data?.osNotifications,
    ),
    terminalDrawerCollapsed:
      typeof data?.terminalDrawerCollapsed === 'boolean'
        ? data.terminalDrawerCollapsed
        : DEFAULT_PREFERENCES.terminalDrawerCollapsed,
    terminalDrawerHeight:
      typeof data?.terminalDrawerHeight === 'number' &&
      Number.isFinite(data.terminalDrawerHeight)
        ? Math.min(
            MAX_TERMINAL_DRAWER_HEIGHT,
            Math.max(
              MIN_TERMINAL_DRAWER_HEIGHT,
              Math.round(data.terminalDrawerHeight),
            ),
          )
        : DEFAULT_PREFERENCES.terminalDrawerHeight,
    terminalDrawerActiveTabId: isBrowserDrawerTabId(
      data?.terminalDrawerActiveTabId,
    )
      ? data.terminalDrawerActiveTabId
      : DEFAULT_PREFERENCES.terminalDrawerActiveTabId,
    disabledTerminalShellProfileIds: Array.isArray(
      data?.disabledTerminalShellProfileIds,
    )
      ? Array.from(
          new Set(
            data.disabledTerminalShellProfileIds.filter(
              isTerminalShellProfileId,
            ),
          ),
        )
      : DEFAULT_PREFERENCES.disabledTerminalShellProfileIds,
    terminalPresets: normalizeTerminalPresets(data?.terminalPresets),
    osNotifications: normalizeOsNotifications(data?.osNotifications),
    voiceDictationEnabled:
      typeof data?.voiceDictationEnabled === 'boolean'
        ? data.voiceDictationEnabled
        : DEFAULT_PREFERENCES.voiceDictationEnabled,
    closeToTray:
      typeof data?.closeToTray === 'boolean'
        ? data.closeToTray
        : DEFAULT_PREFERENCES.closeToTray,
    globalFocusShortcutEnabled:
      typeof data?.globalFocusShortcutEnabled === 'boolean'
        ? data.globalFocusShortcutEnabled
        : DEFAULT_PREFERENCES.globalFocusShortcutEnabled,
    globalFocusShortcut: normalizeGlobalFocusShortcut(
      data?.globalFocusShortcut,
    ),
    activationQuietHours: normalizeActivationQuietHours(
      data?.activationQuietHours,
    ),
    promotionalNotifications: normalizePromotionalNotifications(
      data?.promotionalNotifications,
      normalizeOsNotifications(data?.osNotifications).categories.activation,
    ),
    ...(typeof data?.osNotificationsDeniedAt === 'string'
      ? { osNotificationsDeniedAt: data.osNotificationsDeniedAt }
      : {}),
    ...(osNotificationOfferAnsweredAt !== undefined
      ? { osNotificationOfferAnsweredAt }
      : {}),
    ...(typeof data?.closeToTrayDisclosedAt === 'string'
      ? { closeToTrayDisclosedAt: data.closeToTrayDisclosedAt }
      : {}),
    mcpHttpAuthDefaultHandler:
      data?.mcpHttpAuthDefaultHandler === 'canopy' ||
      data?.mcpHttpAuthDefaultHandler === 'provider' ||
      data?.mcpHttpAuthDefaultHandler === 'account'
        ? data.mcpHttpAuthDefaultHandler
        : DEFAULT_PREFERENCES.mcpHttpAuthDefaultHandler,
    fileIndexing: normalizeFileIndexingPreferences(data?.fileIndexing),
    planDetection: normalizePlanDetectionPreferences(data?.planDetection),
    fileLabels: normalizeFileLabels(data?.fileLabels),
    changedFilesHiddenLabelIds: Array.isArray(data?.changedFilesHiddenLabelIds)
      ? Array.from(
          new Set(
            data.changedFilesHiddenLabelIds.filter(
              (v: unknown): v is string => typeof v === 'string',
            ),
          ),
        )
      : DEFAULT_PREFERENCES.changedFilesHiddenLabelIds,
    autoDownloadUpdates:
      typeof data?.autoDownloadUpdates === 'boolean'
        ? data.autoDownloadUpdates
        : DEFAULT_PREFERENCES.autoDownloadUpdates,
    showDiagnosticsPill:
      typeof data?.showDiagnosticsPill === 'boolean'
        ? data.showDiagnosticsPill
        : DEFAULT_PREFERENCES.showDiagnosticsPill,
    onboardingCompleted,
    releaseHighlightsLastSeenVersion:
      typeof data?.releaseHighlightsLastSeenVersion === 'string'
        ? data.releaseHighlightsLastSeenVersion.trim() || null
        : null,
    guestSessionCount: Math.max(
      0,
      Math.floor(
        normalizeFiniteNumber(
          data?.guestSessionCount,
          DEFAULT_PREFERENCES.guestSessionCount ?? 0,
        ),
      ),
    ),
    guestUpgradeNudgeLastShownSessionCount: Math.max(
      0,
      Math.floor(
        normalizeFiniteNumber(
          data?.guestUpgradeNudgeLastShownSessionCount,
          DEFAULT_PREFERENCES.guestUpgradeNudgeLastShownSessionCount ?? 0,
        ),
      ),
    ),
    ...(typeof data?.mobileInstallCueSnoozedUntil === 'string' &&
    data.mobileInstallCueSnoozedUntil.trim().length > 0
      ? { mobileInstallCueSnoozedUntil: data.mobileInstallCueSnoozedUntil }
      : {}),
    ...(homeOnboardingSuggestions !== undefined
      ? { homeOnboardingSuggestions }
      : {}),
    ...(planModeHint !== undefined ? { planModeHint } : {}),
    ...(githubStarPrompt !== undefined ? { githubStarPrompt } : {}),
    ...buildOnboardingProfileFields(data),
    ...(typeof data?.guestConsentAcceptedAt === 'string' &&
    data.guestConsentAcceptedAt.trim().length > 0
      ? { guestConsentAcceptedAt: data.guestConsentAcceptedAt }
      : {}),
    ...(typeof data?.guestConsentTosVersion === 'string' &&
    data.guestConsentTosVersion.trim().length > 0
      ? { guestConsentTosVersion: data.guestConsentTosVersion }
      : {}),
    ...(typeof data?.legalConsentAcceptedAt === 'string' &&
    data.legalConsentAcceptedAt.trim().length > 0
      ? { legalConsentAcceptedAt: data.legalConsentAcceptedAt }
      : {}),
    ...(typeof data?.legalConsentTosVersion === 'string' &&
    data.legalConsentTosVersion.trim().length > 0
      ? { legalConsentTosVersion: data.legalConsentTosVersion }
      : {}),
    personalWorkspaceCatalogSync:
      data?.personalWorkspaceCatalogSync === 'private' ? 'private' : 'off',
    personalCatalogOfferSeen: data?.personalCatalogOfferSeen === true,
    personalCatalogNotice:
      data?.personalCatalogNotice === 'collision' ||
      data?.personalCatalogNotice === 'removed' ||
      data?.personalCatalogNotice === 'full' ||
      data?.personalCatalogNotice === 'failed'
        ? data.personalCatalogNotice
        : null,
    ...(dataSharingOptInHints ? { dataSharingOptInHints } : {}),
    ...(dataSharingOptInHistory ? { dataSharingOptInHistory } : {}),
    ...(nativeProviderAccounts ? { nativeProviderAccounts } : {}),
    telemetrySharing: normalizeTelemetrySharing(data?.telemetrySharing),
    // Legacy tier marker: kept as read so older files round-trip; nothing
    // writes it, and plan changes never rewrite `telemetrySharing`.
    ...(data?.telemetrySharingTier === 'free' ||
    data?.telemetrySharingTier === 'paid'
      ? { telemetrySharingTier: data.telemetrySharingTier }
      : {}),
    telemetrySharingPromptSeen:
      typeof data?.telemetrySharingPromptSeen === 'boolean'
        ? data.telemetrySharingPromptSeen
        : DEFAULT_PREFERENCES.telemetrySharingPromptSeen,
    gitExecutablePath: normalizeString(
      data?.gitExecutablePath,
      DEFAULT_PREFERENCES.gitExecutablePath,
    ),
    appAdvisorProjectAgentAccess: normalizeAppAdvisorProjectAgentAccess(
      data?.appAdvisorProjectAgentAccess,
    ),
    codeGraph: normalizeCodeGraphPreferences(data?.codeGraph),
  };
}

/** Execution projection only. Mutations must use the stored view in updatePreferencesFile. */
export async function readPreferencesFile(): Promise<PreferencesData> {
  return enqueuePreferencesOperation(() => readPreferencesData('runtime'));
}

export interface PreferencesAuthorityRead {
  preferences: PreferencesData;
  authority: 'ok' | 'absent' | 'unreadable';
  /**
   * Set only when requested and authority is unreadable: the values
   * `readPreferencesFile()` serves, for settings that are not authority.
   */
  served?: PreferencesData;
}

/**
 * The supported last-good (or latched) fallback `readPreferencesFile()` serves,
 * read without recovery or writes. Never authority.
 */
async function readServedPreferencesFallback(
  filePath: string,
): Promise<PreferencesData> {
  const latched = failedPreferencesRecoveries.get(filePath);
  if (latched) return normalizePreferences(latched.fallback);
  const lastGood = await readLastGoodPreferencesFile(filePath);
  const latchedDuringRead = failedPreferencesRecoveries.get(filePath);
  if (latchedDuringRead)
    return normalizePreferences(latchedDuringRead.fallback);
  return normalizePreferences(
    lastGood.status === 'ok' ? lastGood.preferences : DEFAULT_PREFERENCES,
  );
}

/**
 * Read authority without recovery writes, for decisions that can delete
 * persisted state. `preferences` is defaults unless authority is `ok`;
 * `includeServed` adds the served fallback for non-authority settings.
 */
export async function readPreferencesFileDetailed(
  options: { includeServed?: boolean } = {},
): Promise<PreferencesAuthorityRead> {
  // Main's durability only; last-good is awaited only where it is read.
  await writePreferencesQueue;
  const filePath = getPreferencesFilePath();
  const unreadable = async (): Promise<PreferencesAuthorityRead> => ({
    preferences: DEFAULT_PREFERENCES,
    authority: 'unreadable',
    ...(options.includeServed === true
      ? { served: await readServedPreferencesFallback(filePath) }
      : {}),
  });
  if (failedPreferencesRecoveries.has(filePath)) {
    return unreadable();
  }
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    await waitForLastGoodRefresh(filePath);
    const absent =
      isMissingFileError(error) &&
      (await stat(createPreferencesLastGoodPath(filePath)).then(
        () => false,
        (lastGoodError: unknown) => isMissingFileError(lastGoodError),
      ));
    // T1: the generation record cannot turn absent into degraded; see
    // readStoredPreferences.
    return absent && !failedPreferencesRecoveries.has(filePath)
      ? { preferences: DEFAULT_PREFERENCES, authority: 'absent' }
      : unreadable();
  }
  // Recovery may have failed while this non-mutating read was in flight.
  if (failedPreferencesRecoveries.has(filePath)) {
    return unreadable();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      isRecord(parsed.preferences)
    ) {
      return {
        preferences: normalizePreferences(parsed.preferences),
        authority: 'ok',
      };
    }
  } catch {
    // Corrupt preferences cannot authorize destructive cleanup.
  }
  return unreadable();
}

async function readPersistedPreferencesFile(): Promise<PreferencesData> {
  return enqueuePreferencesOperation(() => readPreferencesData('persisted'));
}

async function readPreferencesData(
  validation: ModelSelectionValidation,
): Promise<PreferencesData> {
  return (await readStoredPreferences(validation)).preferences;
}

async function readStoredPreferences(
  validation: ModelSelectionValidation,
): Promise<StoredPreferences> {
  const projectRecovery = ({
    preferences,
    generation,
  }: StoredPreferences): StoredPreferences => ({
    preferences:
      validation === 'runtime'
        ? normalizePreferences(preferences)
        : preferences,
    generation,
  });
  const fresh: StoredPreferences = {
    preferences: DEFAULT_PREFERENCES,
    generation: 0,
  };
  const filePath = getPreferencesFilePath();
  const failure = failedPreferencesRecoveries.get(filePath);
  if (failure)
    return projectRecovery({ preferences: failure.fallback, generation: 0 });
  let raw: string;

  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      const lastGood = await readLastGoodPreferencesFile(filePath);
      if (lastGood.status === 'ok') {
        return projectRecovery(
          await recoverOrServeFallback(
            filePath,
            createPreferencesRecoveryError(
              filePath,
              'read',
              'Preferences file is missing.',
              undefined,
              'ENOENT',
            ),
            null,
            undefined,
            lastGood,
          ),
        );
      }

      if (lastGood.status === 'unreadable') {
        recordFailedPreferencesRecovery({
          ...createPreferencesRecoveryError(
            filePath,
            'read',
            'Preferences file is missing and the last known good preferences could not be read.',
            undefined,
            lastGood.code,
          ),
          backupPath: undefined,
        });
      }
      // Both missing: fresh install (Full Access, no global rules) whatever the
      // generation record says; it is not existence proof (CAN-4469 T1, Mike).
      return projectRecovery(fresh);
    }

    return projectRecovery(
      await recoverOrServeFallback(
        filePath,
        createPreferencesRecoveryError(
          filePath,
          'read',
          getErrorMessage(error),
          undefined,
          getErrorCode(error),
        ),
        null,
        undefined,
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return projectRecovery(
      await recoverOrServeFallback(
        filePath,
        createPreferencesRecoveryError(
          filePath,
          'parse',
          getErrorMessage(error),
        ),
        raw,
        null,
      ),
    );
  }

  if (!isRecord(parsed) || parsed.version !== 1) {
    return projectRecovery(
      await recoverOrServeFallback(
        filePath,
        createPreferencesRecoveryError(
          filePath,
          'version',
          'Unsupported preferences file version.',
          isRecord(parsed) ? parsed.version : undefined,
        ),
        raw,
        parsed,
      ),
    );
  }

  if (!isRecord(parsed.preferences)) {
    return projectRecovery(
      await recoverOrServeFallback(
        filePath,
        createPreferencesRecoveryError(
          filePath,
          'parse',
          'Preferences payload does not contain a valid preferences object.',
        ),
        raw,
        parsed,
      ),
    );
  }

  if (
    parsed.preferences.planModeHint !== undefined &&
    normalizePlanModeHintRecord(parsed.preferences.planModeHint) === undefined
  ) {
    // Leave the original file intact. The renderer's existing __error gate
    // hides the lesson, and hint updates must refuse this degraded snapshot.
    lastPreferencesLoadError = {
      timestamp: new Date().toISOString(),
      filePath,
      reason: 'parse',
      message:
        'Plan mode hint preferences contain an invalid or unsupported record.',
    };
  }
  if (
    parsed.preferences.githubStarPrompt !== undefined &&
    normalizeGitHubStarPromptRecord(parsed.preferences.githubStarPrompt) ===
      undefined
  ) {
    // As above: keep the original file, hide the prompt, refuse its updates.
    lastPreferencesLoadError = {
      timestamp: new Date().toISOString(),
      filePath,
      reason: 'parse',
      message:
        'GitHub star prompt preferences contain an invalid or unsupported record.',
    };
  }
  return {
    preferences: normalizePreferences(parsed.preferences, validation),
    generation: documentGeneration(parsed),
  };
}

/**
 * Whether this data directory already contains durable preferences state.
 *
 * Startup migrations use this before reading normalized defaults so a truly
 * new install (no primary or last-good file) stays distinguishable from an
 * existing user whose older file simply lacks a newly introduced field.
 */
export async function hasPersistedPreferencesFile(): Promise<boolean> {
  const filePath = getPreferencesFilePath();
  for (const candidate of [filePath, createPreferencesLastGoodPath(filePath)]) {
    const exists = await stat(candidate)
      .then(() => true)
      .catch((error: unknown) => {
        if (isMissingFileError(error)) {
          return false;
        }
        throw error;
      });
    if (exists) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve `localMemoryEnabled` for launch paths that gate harness-native
 * memory suppression. Missing or unreadable preferences use the application
 * default; an explicitly persisted `false` remains an opt-out.
 */
export async function readLocalMemoryEnabledPreference(): Promise<boolean> {
  try {
    const preferences = await readPreferencesFile();
    return preferences.localMemoryEnabled === true;
  } catch {
    return DEFAULT_PREFERENCES.localMemoryEnabled;
  }
}

export function projectPreferencesForRuntime(
  preferences: PreferencesData,
): PreferencesData {
  if (rendererRuntimeProjection?.source === preferences) {
    return rendererRuntimeProjection.result;
  }
  const result = normalizePreferences(preferences);
  rendererRuntimeProjection = { source: preferences, result };
  return result;
}

export function invalidateRendererRuntimePreferencesCache(): void {
  rendererRuntimeProjection = null;
}

export async function readPreferencesFileForRenderer(
  options?: PreferencesProjectionOptions,
): Promise<PreferencesLoadResult> {
  const persisted = await readPersistedPreferencesForRenderer();
  if (options?.view === 'persisted') return persisted;
  return {
    ...projectPreferencesForRuntime(rendererPreferencesCache ?? persisted),
    ...(persisted.__dataDir ? { __dataDir: persisted.__dataDir } : {}),
    ...(persisted.__error ? { __error: persisted.__error } : {}),
  };
}

async function readPersistedPreferencesForRenderer(): Promise<PreferencesLoadResult> {
  if (rendererPreferencesCache) {
    return {
      ...rendererPreferencesCache,
      __dataDir: getResolvedCanopyDataDir(),
      ...(lastPreferencesLoadError
        ? { __error: lastPreferencesLoadError }
        : {}),
    };
  }
  if (preferencesRendererLoadOperation) {
    return preferencesRendererLoadOperation;
  }

  const loadOperation = (async (): Promise<PreferencesLoadResult> => {
    let preferences = await readPersistedPreferencesFile();
    if (
      lastPreferencesLoadError === null &&
      !failedPreferencesRecoveries.has(getPreferencesFilePath()) &&
      preferences.osNotifications.enabled &&
      preferences.osNotificationOfferAnsweredAt === undefined
    ) {
      // The renderer must receive durable suppression for enabled profiles.
      // Re-read inside the existing queue so a concurrent answer or Settings
      // change wins. The normalizer itself remains free of writes and clocks.
      preferences = await updatePreferencesFile((current) => {
        if (lastPreferencesLoadError !== null) {
          throw new Error(
            'Preferences could not be read for notification offer migration.',
          );
        }
        if (
          !current.osNotifications.enabled ||
          current.osNotificationOfferAnsweredAt !== undefined
        ) {
          return null;
        }
        return {
          osNotificationOfferAnsweredAt: notificationOfferMigrationTimestamp(),
        };
      });
    }
    rendererPreferencesCache = preferences;
    const dataDir = getResolvedCanopyDataDir();
    const loadError = lastPreferencesLoadError;
    if (loadError) {
      return {
        ...preferences,
        __dataDir: dataDir,
        __error: loadError,
      };
    }
    return {
      ...preferences,
      __dataDir: dataDir,
    };
  })();

  preferencesRendererLoadOperation = loadOperation;
  try {
    return await loadOperation;
  } finally {
    if (preferencesRendererLoadOperation === loadOperation) {
      preferencesRendererLoadOperation = null;
    }
  }
}

export async function writePreferencesFile(
  preferences: Partial<PreferencesData>,
): Promise<PreferencesData> {
  return updatePreferencesFile(() => preferences);
}

export async function updatePreferencesFile(
  updater: PreferencesUpdater,
  onCommitted?: PreferencesCommitObserver,
): Promise<PreferencesData> {
  const result = await updatePreferencesFileWithPrevious(updater, onCommitted);
  return result.next;
}

/** Model preferences whose default follows provider availability. */
const USER_SELECTED_MODEL_FLAGS = {
  summaryModel: 'summaryModelSetByUser',
  localMemoryModel: 'localMemoryModelSetByUser',
} as const satisfies Partial<
  Record<keyof PreferencesData, keyof PreferencesData>
>;

const MODEL_SELECTION_PREFERENCE_KEYS = [
  'summaryModel',
  'handoffSummaryModel',
  'worktreeSummaryModel',
  'planDiagramModel',
  'codeReviewModel',
  'prGenerationModel',
  'commitGenerationModel',
  'branchNamingModel',
  'pipelineAdvisorModel',
  'appAdvisorModel',
  'cronGenerationModel',
  'ifCommandGenerationModel',
  'splitPrPlannerModel',
  'agentRebaseResolutionModel',
  'localMemoryModel',
] as const satisfies readonly (keyof PreferencesData)[];

function normalizePreferenceUpdate(
  existing: PreferencesData,
  patch: Partial<PreferencesData>,
): PreferencesData {
  // A present-but-corrupt hint has no normalized record. Refuse even an
  // unrelated save rather than dropping the original record and remigrating
  // it on reload. Genuine missing preferences normalize to the initial marker.
  if (existing.planModeHint === undefined) {
    throw new Error(
      'Plan mode hint preferences could not be read; preferences were not changed.',
    );
  }
  if (existing.githubStarPrompt === undefined) {
    throw new Error(
      'GitHub star prompt preferences could not be read; preferences were not changed.',
    );
  }
  const merged = { ...existing, ...patch };
  // Keep downgrade data frozen. Only legacy-only patches affect the new gate.
  if (typeof existing.repeatTaskAutomationSuggestionsEnabled === 'boolean') {
    merged.repeatTaskAutomationSuggestionsEnabled =
      existing.repeatTaskAutomationSuggestionsEnabled;
  } else {
    delete merged.repeatTaskAutomationSuggestionsEnabled;
  }
  if ('suggestions' in patch) {
    const incoming = parseSuggestionsState(patch.suggestions);
    if (incoming === null) throw new Error('Invalid suggestions preferences.');
    // Even generic preference saves cannot forge dismissal/display times.
    const now = new Date().toISOString();
    const dismissed = { ...existing.suggestions.dismissed };
    for (const id of SUGGESTION_IDS) {
      if (dismissed[id] === undefined && incoming.dismissed[id] !== undefined)
        dismissed[id] = now;
    }
    const previousAt = existing.suggestions.lastCornerShownAt;
    const incomingAt = incoming.lastCornerShownAt;
    const advances =
      incomingAt !== undefined &&
      (previousAt === undefined ||
        Date.parse(incomingAt) > Date.parse(previousAt));
    const lastCornerShownAt =
      advances &&
      (previousAt === undefined || Date.parse(now) > Date.parse(previousAt))
        ? now
        : previousAt;
    merged.suggestions = {
      enabled: incoming.enabled,
      dismissed,
      ...(lastCornerShownAt === undefined ? {} : { lastCornerShownAt }),
    };
  } else if (
    typeof patch.repeatTaskAutomationSuggestionsEnabled === 'boolean'
  ) {
    merged.suggestions = {
      ...existing.suggestions,
      enabled: patch.repeatTaskAutomationSuggestionsEnabled,
    };
  }
  if ('planModeHint' in patch) {
    // This runs after the authoritative re-read, inside the main-owned queue.
    // A renderer-local queue cannot protect another window's stale snapshot.
    if (peekPreferencesLoadError() !== null) {
      throw new Error(
        'Preferences could not be read; the plan mode hint was not changed.',
      );
    }
    const incoming = normalizePlanModeHintRecord(patch.planModeHint);
    if (incoming === undefined) {
      throw new Error('Invalid plan mode hint preferences.');
    }
    merged.planModeHint = mergePlanModeHintRecords(
      existing.planModeHint,
      incoming,
    );
  }
  if ('githubStarPrompt' in patch) {
    // Same main-owned merge: a stale window cannot lower the count or
    // resurrect a retired prompt.
    if (peekPreferencesLoadError() !== null) {
      throw new Error(
        'Preferences could not be read; the GitHub star prompt was not changed.',
      );
    }
    const incoming = normalizeGitHubStarPromptRecord(patch.githubStarPrompt);
    if (incoming === undefined) {
      throw new Error('Invalid GitHub star prompt preferences.');
    }
    merged.githubStarPrompt = mergeGitHubStarPromptRecords(
      existing.githubStarPrompt,
      incoming,
    );
  }
  // No new checklist writes. Preserve legacy input for hint migration.
  merged.homeOnboardingSuggestions = existing.homeOnboardingSuggestions;
  // Preserve a read-derived legacy answer before a checklist reset can erase
  // its source, and the first durable answer when Settings and the offer race.
  const answer =
    existing.osNotificationOfferAnsweredAt ??
    normalizeOptInTimestamp(patch.osNotificationOfferAnsweredAt);
  if (answer !== undefined) {
    merged.osNotificationOfferAnsweredAt = answer;
  } else if (
    existing.osNotifications.enabled ||
    patch.osNotifications?.enabled === true
  ) {
    // Enabling notifications is an answer; disabling an already-enabled
    // profile must also retain its permanent suppression, even before loading
    // the renderer has triggered a separate migration write.
    merged.osNotificationOfferAnsweredAt =
      notificationOfferMigrationTimestamp();
  }
  for (const modelKey of ['summaryModel', 'localMemoryModel'] as const) {
    const flagKey = USER_SELECTED_MODEL_FLAGS[modelKey];
    // Writing a model is choosing it, unless the writer states otherwise
    // (the legacy summary-model migration records an inferred flag).
    if (modelKey in patch && !(flagKey in patch)) merged[flagKey] = true;
  }
  const normalized = normalizePreferences(merged, 'persisted');
  // Check the current disk value inside the main-owned write queue. A stale
  // renderer/remount must never roll back an already recorded release.
  if ('releaseHighlightsLastSeenVersion' in patch) {
    const previous = existing.releaseHighlightsLastSeenVersion;
    const recorded = previous === null ? null : parseReleaseVersion(previous);
    const next = normalized.releaseHighlightsLastSeenVersion;
    const requested = next === null ? null : parseReleaseVersion(next);
    if (
      recorded &&
      (!requested || compareReleaseVersions(requested, recorded) <= 0)
    ) {
      normalized.releaseHighlightsLastSeenVersion = previous;
    }
  }
  let available: PreferencesData | undefined;
  const validateChanges = (): PreferencesData =>
    (available ??= normalizePreferences(merged));

  for (const key of MODEL_SELECTION_PREFERENCE_KEYS) {
    if (
      key in patch &&
      normalizePersistableModelSelection(patch[key]) !== existing[key]
    ) {
      if (key === 'handoffSummaryModel' && !resolveAvailableModel(patch[key])) {
        throw new Error(
          'Choose an available conversation handoff model in Settings.',
        );
      }
      Object.assign(normalized, { [key]: validateChanges()[key] });
      if (key === 'summaryModel' || key === 'localMemoryModel') {
        const flagKey = USER_SELECTED_MODEL_FLAGS[key];
        Object.assign(normalized, { [flagKey]: validateChanges()[flagKey] });
      }
    }
  }

  for (const key of [
    'defaultChatModelByProvider',
    'defaultWorktreeModelByProvider',
  ] as const) {
    if (!(key in patch)) continue;
    for (const provider of [
      'claude',
      'codex',
      'ollama',
      'aiCredits',
    ] as const) {
      const selection = patch[key]?.[provider];
      if (
        normalizePersistableModelSelection(selection?.model) !==
        (existing[key][provider]?.model ?? null)
      ) {
        Object.assign(normalized[key], {
          [provider]: validateChanges()[key][provider],
        });
      }
    }
  }
  normalized.defaultChatProvider = normalizeDefaultProvider(
    merged.defaultChatProvider,
    normalized.defaultChatModelByProvider,
    DEFAULT_PREFERENCES.defaultChatProvider,
  );
  normalized.defaultWorktreeProvider = normalizeDefaultProvider(
    merged.defaultWorktreeProvider,
    normalized.defaultWorktreeModelByProvider,
    DEFAULT_PREFERENCES.defaultWorktreeProvider,
  );
  return normalized;
}

function notificationOfferMigrationTimestamp(): string {
  const filePath = getPreferencesFilePath();
  const existing = osNotificationOfferMigrationTimestamps.get(filePath);
  if (existing !== undefined) return existing;
  const timestamp = new Date().toISOString();
  osNotificationOfferMigrationTimestamps.set(filePath, timestamp);
  return timestamp;
}

export async function updatePreferencesFileWithPrevious(
  updater: PreferencesUpdater,
  onCommitted?: PreferencesCommitObserver,
): Promise<{ previous: PreferencesData; next: PreferencesData }> {
  const writeOperation = enqueuePreferencesOperation(async () => {
    const filePath = getPreferencesFilePath();
    assertPreferencesWritable(filePath);
    const { preferences: existing, generation: storedGeneration } =
      await readStoredPreferences('persisted');
    assertPreferencesWritable(filePath);
    const preferences = await updater(existing);
    if (preferences === null) {
      return { previous: existing, next: existing };
    }
    const normalized = normalizePreferenceUpdate(existing, preferences);

    const globalRulesChanged =
      JSON.stringify(existing.globalApprovalRules) !==
      JSON.stringify(normalized.globalApprovalRules);
    const authorityChanged =
      globalRulesChanged ||
      JSON.stringify(existing.approvalDefaults) !==
        JSON.stringify(normalized.approvalDefaults);
    await createPreferencesFolderDurably(filePath);
    const generation = await nextPreferencesGeneration(
      filePath,
      storedGeneration,
    );
    const content = serializePreferencesFile(normalized, generation);
    // Tracked from the record's write: the barrier covers the whole save.
    const save = (async (): Promise<void> => {
      // Main is untouched if this fails, even with an unknown outcome, so
      // the authority marks stay as they are.
      await writePreferencesGeneration(filePath, generation);
      try {
        await writeTextFileAtomically(filePath, content);
      } catch (error) {
        // The new primary may be what the next read sees; drop what caches
        // hold. The record already holds this generation, so recovery will
        // not restore an older last-good over it.
        if (isStorageOutcomeUnknownError(error)) {
          // An unchanged authority is still the confirmed one.
          if (authorityChanged)
            markPreferencesAuthorityUnconfirmed({
              globalApprovalRules: existing.globalApprovalRules,
              approvalDefaults: existing.approvalDefaults,
            });
          invalidateRendererPreferencesCache();
        }
        throw error;
      }
      if (globalRulesChanged) markGlobalApprovalRulesChanged();
      markPreferencesAuthorityConfirmed();
    })();
    await (authorityChanged
      ? trackPreferencesAuthoritySave(save, {
          narrowsFileWrites: narrowsFileWriteRules(
            existing.globalApprovalRules,
            normalized.globalApprovalRules,
          ),
        })
      : save);
    if (existing.opencodeEnabled !== normalized.opencodeEnabled) {
      openCodeEnabledRevision++;
    }
    rendererPreferencesCache = normalized;
    if (
      JSON.stringify(existing.disabledInstalledItems ?? []) !==
        JSON.stringify(normalized.disabledInstalledItems ?? []) ||
      JSON.stringify(existing.parkedCodexPlugins ?? []) !==
        JSON.stringify(normalized.parkedCodexPlugins ?? [])
    ) {
      const { notifyInstalledItemsChanged } =
        await import('../installed-items/installed-item-events');
      notifyInstalledItemsChanged();
    }
    // Main is durable here, so its bytes may become last-good.
    scheduleLastGoodRefresh(filePath, content);
    // Run commit observers before releasing the serialized write queue. This
    // lets ordering metadata become visible atomically with the durable value,
    // so the next queued updater cannot mistake a committed write for a still
    // pending one.
    commitSuggestionsGate(normalized);
    onCommitted?.(normalized);
    return { previous: existing, next: normalized };
  });

  return writeOperation;
}

/**
 * Waits for queued saves and the last-good refreshes they started, again for
 * saves queued meanwhile. Bounded, so a steady writer cannot hold quit open.
 */
export async function flushPreferencesWrites(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    const queue = writePreferencesQueue;
    await queue;
    const refreshes = Array.from(
      lastGoodRefreshes.values(),
      (refresh) => refresh.running,
    );
    if (refreshes.length === 0 && queue === writePreferencesQueue) return;
    await Promise.all(refreshes);
  }
}

export type PreferencesGenerationStamp =
  | 'stamped'
  | 'present'
  | 'fresh'
  | 'degraded'
  | 'failed'
  | 'stopped';

/**
 * A save landed under the record: main carries the recorded generation. A
 * record whose save failed before main, or that an older build left behind
 * main, does not count.
 */
async function isPreferencesSaveRecorded(filePath: string): Promise<boolean> {
  const recorded = await readPreferencesGeneration(filePath);
  if (recorded.status !== 'ok') return false;
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    const generation = isRecord(parsed) ? documentGeneration(parsed) : null;
    return generation !== null && generation >= recorded.generation;
  } catch {
    return false;
  }
}

/**
 * One save of the stored preferences, unless a save already landed under the
 * record. For a profile without a record, that save writes it and retires the
 * legacy last-good as a starting point. Queued like any save; rechecked inside
 * the queue, so a user save that got there first ends it. A latched recovery
 * refuses it until restart. `isStopped` is checked with no await before the
 * save is queued; a queued save completes like any save.
 */
export async function stampPreferencesGeneration(
  isStopped: () => boolean = (): boolean => false,
): Promise<PreferencesGenerationStamp> {
  const filePath = getPreferencesFilePath();
  if (failedPreferencesRecoveries.has(filePath)) return 'degraded';
  let outcome: PreferencesGenerationStamp = 'present';
  try {
    if (await isPreferencesSaveRecorded(filePath)) return 'present';
    // Without main or last-good there is no legacy copy; any save records.
    if (!(await hasPersistedPreferencesFile())) return 'fresh';
    if (isStopped()) return 'stopped';
    // Queued synchronously: from here quit's flush waits for this save.
    await updatePreferencesFileWithPrevious(async () => {
      if (await isPreferencesSaveRecorded(filePath)) return null;
      outcome = 'stamped';
      return {};
    });
  } catch (error) {
    return error instanceof PreferencesRecoveryRequiredError
      ? 'degraded'
      : 'failed';
  }
  return outcome;
}

/** Waits before each attempt; the last delay repeats. */
const PREFERENCES_GENERATION_STAMP_DELAYS_MS = [
  30_000, 30_000, 60_000, 120_000, 300_000,
] as const;

type StampWait = (delayMs: number) => Promise<boolean>;

let preferencesGenerationStamp: {
  run: Promise<PreferencesGenerationStamp>;
  stop: () => void;
} | null = null;

/**
 * Starts the background save that records the generation (Mike, 2026-10-31:
 * the save must be guaranteed). Off the startup path: it waits first, then
 * retries until a save lands under the record. Each launch starts it again,
 * so a quit only defers it. `wait` resolves false once stopped; tests
 * replace it.
 */
export function startPreferencesGenerationStamp(
  wait?: StampWait,
): Promise<PreferencesGenerationStamp> {
  if (preferencesGenerationStamp) return preferencesGenerationStamp.run;
  let stopped = false;
  const isStopped = (): boolean => stopped;
  let cancelTimer = (): void => undefined;
  const waitForTimer: StampWait = (delayMs) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), delayMs);
      timer.unref();
      cancelTimer = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  const waitBeforeAttempt = wait ?? waitForTimer;
  const run = (async (): Promise<PreferencesGenerationStamp> => {
    for (let attempt = 0; ; attempt += 1) {
      const delayMs =
        PREFERENCES_GENERATION_STAMP_DELAYS_MS[
          Math.min(attempt, PREFERENCES_GENERATION_STAMP_DELAYS_MS.length - 1)
        ];
      if (stopped || !(await waitBeforeAttempt(delayMs)) || stopped)
        return 'stopped';
      const outcome = await stampPreferencesGeneration(isStopped);
      if (outcome !== 'failed') return outcome;
      // eslint-disable-next-line no-console
      console.error(
        'Failed to record the preferences generation; retrying in the background.',
      );
    }
  })();
  const stamp = {
    run,
    stop: (): void => {
      stopped = true;
      cancelTimer();
      release();
    },
  };
  function release(): void {
    if (preferencesGenerationStamp === stamp) preferencesGenerationStamp = null;
  }
  preferencesGenerationStamp = stamp;
  void run.then(release, release);
  return run;
}

/**
 * Quit stops future attempts. An attempt already queued completes, and quit's
 * flush waits for it, as for any save.
 */
export function stopPreferencesGenerationStamp(): void {
  preferencesGenerationStamp?.stop();
}

export async function readLatestPreferencesFile(): Promise<PreferencesData> {
  await writePreferencesQueue;
  return rendererPreferencesCache ?? readPreferencesFile();
}

export function invalidateRendererPreferencesCache(): void {
  rendererPreferencesCache = null;
  invalidateRendererRuntimePreferencesCache();
}

/**
 * Read the pending preferences load/recovery error WITHOUT consuming it.
 *
 * `readPreferencesFile()` silently falls back to defaults (or to a recovered
 * last-known-good file) when the real preferences file is unreadable, corrupt,
 * or on an unsupported version — callers cannot otherwise tell a genuine
 * "user has no such preference" from "we never managed to read their file".
 * Startup migrations use this to avoid acting on, and permanently marking
 * themselves against, preferences that were never actually observed.
 *
 * Non-clearing on purpose: the app shell acknowledges the error only after it
 * has surfaced the recovery notification to the user.
 */
export function peekPreferencesLoadError(): PreferencesLoadErrorDetails | null {
  return lastPreferencesLoadError;
}

/** Clear a recovery error after the app shell has surfaced it to the user. */
export function acknowledgePreferencesLoadError(): void {
  lastPreferencesLoadError = null;
}

export function resetPreferencesLoadErrorForTests(): void {
  stopPreferencesGenerationStamp();
  failedPreferencesRecoveries.clear();
  lastPreferencesLoadError = null;
  preferencesRendererLoadOperation = null;
  osNotificationOfferMigrationTimestamps.clear();
  markPreferencesAuthorityConfirmed();
  invalidateRendererPreferencesCache();
}
