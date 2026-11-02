import { readFile } from 'node:fs/promises';
import {
  DEFAULT_LOCAL_MEMORY_FALLBACK_MODEL,
  DEFAULT_LOCAL_MEMORY_MODEL,
  getProviderForModel,
  isOllamaModel,
  isThinkingLevel,
  type ChatModel,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  createDefaultSidebarNavLayout,
  isLegacyDefaultSidebarNavLayout,
} from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import { hasMigrationRun, markMigrationRun } from './migrations';
import { getPreferencesFilePath } from './paths';
import { createPreferencesLastGoodPath } from './preferences-file-paths';
import {
  hasPersistedPreferencesFile,
  normalizePersistableModelSelection,
  peekPreferencesLoadError,
  readPreferencesFile,
  updatePreferencesFile,
} from './preferences-store';

export const APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY =
  'approval_defaults_full_access';
export const CLAUDE_WORKER_MODES_CANOPY_MIGRATION_KEY =
  'claude_worker_modes_canopy';
export const SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY =
  'sidebar_remote_control_visible';
export const SIDEBAR_MORE_PAGES_TO_MAIN_MIGRATION_KEY =
  'sidebar_more_pages_to_main';
export const CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY =
  'chat_summary_model_selection';
/**
 * The chat-description default when legacy profiles were written. A legacy
 * profile without the selection marker chose its model only if it differs
 * from this one.
 */
const LEGACY_DEFAULT_SUMMARY_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Chat-summary defaults seeded by earlier releases. A legacy profile without a
 * marker that still holds one of these never chose its summary model.
 */
const SEEDED_SUMMARY_MODELS: ReadonlySet<string> = new Set([
  'haiku',
  LEGACY_DEFAULT_SUMMARY_MODEL,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ChatSummaryModelSelectionMigrationSnapshot {
  hasPersistedPreferences: boolean;
  marker?: boolean;
  model?: unknown;
  readError?: boolean;
  source?: 'primary' | 'last-good';
}

type PersistedPreferencesRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | {
      kind: 'read';
      source: 'primary' | 'last-good';
      preferences: Record<string, unknown>;
    };

/** The stored preferences exactly as written, before any normalization. */
async function readPersistedPreferences(): Promise<PersistedPreferencesRead> {
  if (!(await hasPersistedPreferencesFile())) {
    return { kind: 'missing' };
  }
  const preferencesPath = getPreferencesFilePath();
  const candidates: Array<{
    path: string;
    source: 'primary' | 'last-good';
  }> = [
    { path: preferencesPath, source: 'primary' },
    {
      path: createPreferencesLastGoodPath(preferencesPath),
      source: 'last-good',
    },
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(candidate.path, 'utf8'),
      );
      if (
        !isRecord(parsed) ||
        parsed.version !== 1 ||
        !isRecord(parsed.preferences)
      ) {
        continue;
      }
      return {
        kind: 'read',
        source: candidate.source,
        preferences: parsed.preferences,
      };
    } catch {
      continue;
    }
  }
  return { kind: 'unreadable' };
}

function chatSummaryModelSelectionSnapshot(
  read: PersistedPreferencesRead,
): ChatSummaryModelSelectionMigrationSnapshot {
  if (read.kind === 'missing') return { hasPersistedPreferences: false };
  if (read.kind === 'unreadable') {
    return { hasPersistedPreferences: true, readError: true };
  }
  return {
    hasPersistedPreferences: true,
    source: read.source,
    marker:
      typeof read.preferences.summaryModelSetByUser === 'boolean'
        ? read.preferences.summaryModelSetByUser
        : undefined,
    model: read.preferences.summaryModel,
  };
}

/** Capture legacy fields before any earlier startup migration normalizes them. */
export async function captureChatSummaryModelSelectionMigrationSnapshot(): Promise<ChatSummaryModelSelectionMigrationSnapshot> {
  return chatSummaryModelSelectionSnapshot(await readPersistedPreferences());
}

/**
 * Materialize whether a legacy chat-summary model was user-selected before
 * every subsequent preference write serializes the full normalized object.
 */
export async function migrateChatSummaryModelSelection(
  capturedSnapshot?: ChatSummaryModelSelectionMigrationSnapshot,
): Promise<void> {
  if (await hasMigrationRun(CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY)) {
    return;
  }

  const snapshot =
    capturedSnapshot ??
    (await captureChatSummaryModelSelectionMigrationSnapshot());
  if (!snapshot.hasPersistedPreferences) {
    await markMigrationRun(CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY);
    return;
  }
  if (snapshot.readError) {
    return;
  }
  await readPreferencesFile();
  if (peekPreferencesLoadError() && snapshot.source !== 'last-good') {
    return;
  }
  const normalizedPersistedModel = normalizePersistableModelSelection(
    snapshot.model,
  );

  await updatePreferencesFile(() => ({
    ...(normalizedPersistedModel === null
      ? {}
      : { summaryModel: normalizedPersistedModel }),
    summaryModelSetByUser:
      normalizedPersistedModel === null
        ? false
        : (snapshot.marker ??
          !SEEDED_SUMMARY_MODELS.has(normalizedPersistedModel)),
  }));
  await markMigrationRun(CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY);
}

/**
 * Restore Full Access for profiles that persisted an explicit Ask/Auto value
 * during an intermediate release. Full Access is now the product default, so
 * fresh installs already start there and are marked as not applicable
 * immediately; this migration only exists so an upgrading profile is not left
 * behind on a stricter persisted posture.
 */
export async function migrateApprovalDefaultsToFullAccess(
  hadPersistedPreferencesAtStartup?: boolean,
): Promise<void> {
  if (await hasMigrationRun(APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY)) {
    return;
  }

  const hadPersistedPreferences =
    hadPersistedPreferencesAtStartup ?? (await hasPersistedPreferencesFile());
  if (!hadPersistedPreferences) {
    await markMigrationRun(APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY);
    return;
  }

  await readPreferencesFile();
  if (peekPreferencesLoadError()) {
    return;
  }

  // Deliberately replace all persisted surface selections. Before approval
  // defaults shipped, every existing profile behaved as unrestricted; this
  // one-time compatibility migration preserves that posture even when an
  // intermediate release already serialized newly introduced Ask/Auto values.
  //
  // Re-arm the one-time disclosure notice whenever that replacement actually
  // changes something. This migration overwrites a posture the user may have
  // chosen deliberately, and a profile old enough to still need it has almost
  // certainly dismissed the earlier notice already — so without the re-arm the
  // escalation would ship with no disclosure at all. When the posture was
  // already Full Access there is nothing to disclose or write, so the user's
  // dismissal and the file are left alone.
  await updatePreferencesFile((latest) =>
    latest.approvalDefaults.worktree === 'full-access' &&
    latest.approvalDefaults.cowork === 'full-access' &&
    latest.approvalDefaults.appAdvisor === 'full-access'
      ? null
      : {
          approvalDefaults: {
            worktree: 'full-access',
            cowork: 'full-access',
            appAdvisor: 'full-access',
          },
          approvalsUpgradeNoticeDismissed: false,
        },
  );
  await markMigrationRun(APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY);
}

export async function migrateClaudeWorkerModesToCanopy(): Promise<void> {
  if (await hasMigrationRun(CLAUDE_WORKER_MODES_CANOPY_MIGRATION_KEY)) {
    return;
  }

  const preferences = await readPreferencesFile();
  if (
    preferences.canopyBackgroundProcessesMode !== 'terminal' &&
    preferences.pipelinesMode !== 'terminal'
  ) {
    return;
  }

  await updatePreferencesFile(() => ({
    ...(preferences.canopyBackgroundProcessesMode === 'terminal'
      ? { canopyBackgroundProcessesMode: 'canopy' as const }
      : {}),
    ...(preferences.pipelinesMode === 'terminal'
      ? { pipelinesMode: 'canopy' as const }
      : {}),
  }));
  await markMigrationRun(CLAUDE_WORKER_MODES_CANOPY_MIGRATION_KEY);
}

export async function migrateSidebarRemoteControlVisible(): Promise<void> {
  if (await hasMigrationRun(SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY)) {
    return;
  }

  const preferences = await readPreferencesFile();

  // A degraded read (unreadable/corrupt/wrong-version file, with or without a
  // successful recovery) hands back defaults rather than what the user
  // actually had stored. Marking the migration done here would burn the one
  // shot we get: their real legacy layout would never be inspected, even after
  // the file is repaired on a later launch. Bail and retry next startup.
  if (peekPreferencesLoadError()) {
    return;
  }

  if (isLegacyDefaultSidebarNavLayout(preferences.sidebarNavLayout)) {
    await updatePreferencesFile(() => ({
      sidebarNavLayout: createDefaultSidebarNavLayout(),
    }));
  }

  await markMigrationRun(SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY);
}

/**
 * CAN-3678 empties the sidebar's More menu: every More key except Environments
 * moves to the end of main nav, keeping its relative order, so the previous
 * default layout becomes exactly the current one. The five Labs page keys then
 * render only while their experiment is on. CAN-4269 removes Environments
 * during reconciliation, so current layouts have no retained More keys.
 * Must run after
 * {@link migrateSidebarRemoteControlVisible}, which first upgrades a legacy
 * default layout to the current default.
 */
export async function migrateSidebarMorePagesToMain(): Promise<void> {
  if (await hasMigrationRun(SIDEBAR_MORE_PAGES_TO_MAIN_MIGRATION_KEY)) {
    return;
  }

  const preferences = await readPreferencesFile();

  // A degraded read hands back the default layout instead of the stored one;
  // marking the migration done on it would burn the one shot. Bail and retry
  // next startup (same contract as migrateSidebarRemoteControlVisible).
  if (peekPreferencesLoadError()) {
    return;
  }

  // The store reconciles the layout on read, so `moreStartIndex` is in range.
  const { order, moreStartIndex } = preferences.sidebarNavLayout;
  const main = order.slice(0, moreStartIndex);
  const more = order.slice(moreStartIndex);
  const keepsEnvironments = more.includes('environments');
  const moved = more.filter((key) => key !== 'environments');
  if (moved.length > 0) {
    const nextOrder = [
      ...main,
      ...moved,
      ...(keepsEnvironments ? ['environments'] : []),
    ];
    await updatePreferencesFile(() => ({
      sidebarNavLayout: {
        order: nextOrder,
        moreStartIndex: nextOrder.length - (keepsEnvironments ? 1 : 0),
      },
    }));
  }

  await markMigrationRun(SIDEBAR_MORE_PAGES_TO_MAIN_MIGRATION_KEY);
}

export const LOCAL_MEMORY_DEFAULT_ON_MIGRATION_KEY = 'local_memory_default_on';

// CAN-2657 product decision (Nick, 2026-09-01): local memory turns ON for
// everyone at upgrade. Preferences serialize as a full object, so opt-in-era
// profiles carry a materialized `localMemoryEnabled: false`; this one-shot
// lift applies to every persisted `false` — deliberate opt-in-era opt-outs
// included — because the two are indistinguishable on disk and the accepted
// remedy is the visible Experiments toggle. The explicit-choice marker
// (`localMemoryEnabledSetByUser`, written from this release on) is honored so
// an opt-out made after the decision is never overridden, and the migration
// never re-runs.
export async function migrateLocalMemoryDefaultOn(): Promise<void> {
  if (await hasMigrationRun(LOCAL_MEMORY_DEFAULT_ON_MIGRATION_KEY)) {
    return;
  }

  const preferences = await readPreferencesFile();

  // A degraded read hands back defaults rather than the stored value; marking
  // the migration done on it would burn the one shot. Bail and retry next
  // startup (same contract as migrateSidebarRemoteControlVisible).
  if (peekPreferencesLoadError()) {
    return;
  }

  if (
    preferences.localMemoryEnabled === false &&
    preferences.localMemoryEnabledSetByUser !== true
  ) {
    await updatePreferencesFile(() => ({ localMemoryEnabled: true }));
  }

  await markMigrationRun(LOCAL_MEMORY_DEFAULT_ON_MIGRATION_KEY);
}

export const SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY =
  'sidebar_manual_sort_default';

// Product decision (2026-09-25): the left nav defaults to manual order at
// every level, so rows stop jumping as activity lands. Preferences serialize
// as a full object, so recency-default-era profiles carry a materialized
// `sidebarProjectSortMode: 'last-updated'` whether or not the user picked it;
// this one-shot moves every such value to manual, because the two are
// indistinguishable on disk and the Sort by menu restores recency in one
// click. It never re-runs, so a later choice of Last updated persists.
// Workspace-level `itemSortMode` needs no migration: that field was only ever
// written for an explicit manual choice, and a missing value now reads as
// manual.
export async function migrateSidebarManualSortDefault(): Promise<void> {
  if (await hasMigrationRun(SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY)) {
    return;
  }

  const preferences = await readPreferencesFile();

  // A degraded read hands back defaults rather than the stored value; marking
  // the migration done on it would burn the one shot. Bail and retry next
  // startup (same contract as migrateSidebarRemoteControlVisible).
  if (peekPreferencesLoadError()) {
    return;
  }

  if (preferences.sidebarProjectSortMode === 'last-updated') {
    await updatePreferencesFile(() => ({ sidebarProjectSortMode: 'manual' }));
  }

  await markMigrationRun(SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY);
}

export const OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY =
  'open_app_links_in_built_in_browser_default';

// Product decision (2026-10-21): links clicked in the app open in the
// built-in browser by default. Preferences serialize as a full object, so
// every earlier profile carries a materialized
// `openAppLinksInBuiltInBrowser: false` whether or not the user chose it; this
// one-shot turns all of them on, because the two are indistinguishable on
// disk and Settings → Browser turns it off in one click. It never re-runs, so
// a later choice of off persists.
export async function migrateOpenAppLinksInBuiltInBrowserDefault(): Promise<void> {
  if (
    await hasMigrationRun(
      OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY,
    )
  ) {
    return;
  }

  const preferences = await readPreferencesFile();

  // A degraded read hands back defaults rather than the stored value; marking
  // the migration done on it would burn the one shot. Bail and retry next
  // startup (same contract as migrateSidebarRemoteControlVisible).
  if (peekPreferencesLoadError()) {
    return;
  }

  if (preferences.openAppLinksInBuiltInBrowser === false) {
    await updatePreferencesFile(() => ({ openAppLinksInBuiltInBrowser: true }));
  }

  await markMigrationRun(
    OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY,
  );
}

export const LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY =
  'local_memory_model_from_summary';

export interface LocalMemoryModelMigrationSnapshot {
  hasPersistedPreferences: boolean;
  readError?: boolean;
  source?: 'primary' | 'last-good';
  /**
   * The stored explicit-choice marker. Normalized writes from earlier startup
   * migrations materialize the local memory fields with this set to false, so
   * only `true` is a choice this migration must keep.
   */
  localMemoryModelSetByUser?: unknown;
  summaryModel?: unknown;
  summaryModelSetByUser?: unknown;
  summaryThinkingLevel?: unknown;
}

function localMemoryModelSnapshot(
  read: PersistedPreferencesRead,
): LocalMemoryModelMigrationSnapshot {
  if (read.kind === 'missing') return { hasPersistedPreferences: false };
  if (read.kind === 'unreadable') {
    return { hasPersistedPreferences: true, readError: true };
  }
  return {
    hasPersistedPreferences: true,
    source: read.source,
    localMemoryModelSetByUser: read.preferences.localMemoryModelSetByUser,
    summaryModel: read.preferences.summaryModel,
    summaryModelSetByUser: read.preferences.summaryModelSetByUser,
    summaryThinkingLevel: read.preferences.summaryThinkingLevel,
  };
}

/**
 * Capture the old memory model before any startup write materializes the new
 * local memory fields with their defaults.
 */
export async function captureLocalMemoryModelMigrationSnapshot(): Promise<LocalMemoryModelMigrationSnapshot> {
  return localMemoryModelSnapshot(await readPersistedPreferences());
}

export interface PreferenceMigrationSnapshots {
  chatSummaryModelSelection: ChatSummaryModelSelectionMigrationSnapshot;
  localMemoryModel: LocalMemoryModelMigrationSnapshot;
}

/**
 * Every startup snapshot from one read of the stored preferences, taken before
 * any startup service or migration writes the normalized object.
 */
export async function capturePreferenceMigrationSnapshots(): Promise<PreferenceMigrationSnapshots> {
  const read = await readPersistedPreferences();
  return {
    chatSummaryModelSelection: chatSummaryModelSelectionSnapshot(read),
    localMemoryModel: localMemoryModelSnapshot(read),
  };
}

// CAN-3529: local memory used to run on the chat summary model. The
// migration never moves saved memory to a provider the user did not choose:
// - An Ollama summary model keeps memory on that exact local model, so a
//   memory run refuses rather than send saved memory to another provider
//   while it is unavailable.
// - A remote summary model the user chose keeps memory on that provider, on
//   its strong default: GPT 6.1 Sol for Codex, the Opus default for Claude,
//   both at high thinking. A model from any other provider is kept as is.
// - A summary model the user never chose gets the provider-aware default.
// Whether a legacy model was chosen follows the chat summary migration: the
// stored marker, or, without one, any model other than the old default.
export async function migrateLocalMemoryModelFromSummary(
  capturedSnapshot?: LocalMemoryModelMigrationSnapshot,
): Promise<void> {
  if (await hasMigrationRun(LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY)) {
    return;
  }

  const snapshot =
    capturedSnapshot ?? (await captureLocalMemoryModelMigrationSnapshot());
  if (!snapshot.hasPersistedPreferences) {
    await markMigrationRun(LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY);
    return;
  }
  if (snapshot.readError) {
    return;
  }
  // A degraded read hands back defaults; writing over them would burn the one
  // shot (same contract as migrateChatSummaryModelSelection).
  await readPreferencesFile();
  if (peekPreferencesLoadError() && snapshot.source !== 'last-good') {
    return;
  }

  // Completion is decided by the migration ledger alone. The local memory
  // fields can already be on disk with their defaults when an earlier
  // startup stopped after another migration wrote the normalized object, so
  // only an explicit choice (made in Settings, or written by this migration
  // before it could record completion) is kept.
  const choice =
    snapshot.localMemoryModelSetByUser === true
      ? null
      : localMemoryModelFromSummary(snapshot);
  if (choice !== null) {
    await updatePreferencesFile(() => ({
      localMemoryModel: choice.model,
      localMemoryModelSetByUser: true,
      ...(choice.thinkingLevel === undefined
        ? {}
        : { localMemoryThinkingLevel: choice.thinkingLevel }),
    }));
  }
  await markMigrationRun(LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY);
}

/**
 * The local memory model a legacy profile keeps, or null when it takes the
 * provider-aware default (see {@link migrateLocalMemoryModelFromSummary}).
 */
function localMemoryModelFromSummary(
  snapshot: LocalMemoryModelMigrationSnapshot,
): { model: ChatModel; thinkingLevel?: ThinkingLevel } | null {
  const summaryModel = normalizePersistableModelSelection(
    snapshot.summaryModel,
  );
  if (summaryModel === null) return null;
  const summaryThinkingLevel = isThinkingLevel(snapshot.summaryThinkingLevel)
    ? snapshot.summaryThinkingLevel
    : undefined;
  if (isOllamaModel(summaryModel)) {
    return { model: summaryModel, thinkingLevel: summaryThinkingLevel };
  }
  const chosen =
    typeof snapshot.summaryModelSetByUser === 'boolean'
      ? snapshot.summaryModelSetByUser
      : !SEEDED_SUMMARY_MODELS.has(summaryModel);
  if (!chosen) return null;
  switch (getProviderForModel(summaryModel)) {
    case 'codex':
      return { model: DEFAULT_LOCAL_MEMORY_MODEL, thinkingLevel: 'high' };
    case 'claude':
      return {
        model: DEFAULT_LOCAL_MEMORY_FALLBACK_MODEL,
        thinkingLevel: 'high',
      };
    default:
      return { model: summaryModel, thinkingLevel: summaryThinkingLevel };
  }
}
