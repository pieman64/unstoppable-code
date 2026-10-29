import { readdir } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { SkillSuggestionOrigin } from '@canopy/desktop-shared/lib/skill-suggestions';
import {
  getAllActiveSessionInfos,
  hasActiveChatTurns,
  subscribeChatSessionActivity,
} from '../agents/session-manager';
import { skillShareNudgeState } from '../agents/skill-share-nudge-state';
import { recordSkillSuggestionTelemetry } from '../lib/desktop-telemetry';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getWorkspacesRootDir } from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  defaultBackfillSources,
  listRetainedChatIds,
  runBackfill,
} from './backfill';
import type { InventorySkill, ScanModelChoice } from './clustering-generator';
import {
  isSkillSuggestionScanEnabled,
  isSkillSuggestionsEnabled,
  isSkillSuggestionsPreferenceEnabled,
  onSkillSuggestionsGateChanged,
  setSkillSuggestionsPreference,
  startSkillSuggestionsGate,
} from './feature-gate';
import {
  chainMatchId,
  getFingerprintStore,
  turnMatchId,
} from './fingerprint-store';
import { memberOrganizationsNow, readMemberOrganizations } from './owners';
import { resolveTurnPartition } from './partition';
import {
  buildTurnFingerprint,
  ChatChainCache,
  extendChatChain,
} from './recording';
import {
  getSkillSuggestionsRegistry,
  isOpenSuggestion,
  purgeWorkspaceFromState,
  resetForPreferenceOff,
} from './registry';
import { runScanPass } from './scan';
import { SkillSuggestionScheduler } from './scheduler';
import { SkillSuggestionSurfacingState } from './surfacing-state';
import { TimeSlicer } from './time-slicer';
import {
  skillSuggestionTurnRecorder,
  type RecordedTurn,
} from './turn-recorder';

/**
 * Wiring for repeat-task skill suggestions (CAN-385): the live recording
 * sink, the idle scheduler, the kill switch and preference purge, session
 * disposal, and workspace deletion. Started next to the local memory
 * consolidation scheduler.
 */
const store = getFingerprintStore();
const registry = getSkillSuggestionsRegistry();
const chainCache = new ChatChainCache(store);

export const skillSuggestionSurfacing = new SkillSuggestionSurfacingState({
  registry,
  isEnabled: isSkillSuggestionsEnabled,
  now: Date.now,
  isShareNudgePending: (origin): boolean =>
    skillShareNudgeState.hasPending(origin),
  memberOrganizations: memberOrganizationsNow,
  onAction: (action, occurrenceCount): void =>
    recordSkillSuggestionTelemetry({ action, occurrenceCount }),
});

/** Records a completed eligible turn, then checks it against open suggestions. */
export async function handleRecordedTurn(turn: RecordedTurn): Promise<void> {
  const partition = await resolveTurnPartition(turn);
  if (!partition || !isSkillSuggestionsEnabled()) return;
  const row = buildTurnFingerprint(
    {
      projectId: turn.projectId,
      worktreeId: turn.worktreeId,
      chatId: turn.chatId,
      userMessageId: turn.userMessageId,
      auditEntryId: turn.auditEntryId,
      promptText: turn.promptText,
      tools: turn.tools,
      createdAt: turn.completedAt,
      status: turn.status,
    },
    partition,
  );
  if (!row) return;
  const previous = await chainCache.get(turn.chatId);
  const chain = extendChatChain(previous, row);
  // The gate is re-checked before anything is written.
  if (!isSkillSuggestionsEnabled()) return;
  // A turn recorded before (a retry or resume) never extends its chain again.
  const fresh = (await store.append([row])) > 0;
  // Re-checked synchronously, so a preference-off purge queued meanwhile is
  // never followed by this chain row.
  if (fresh && chain && isSkillSuggestionsEnabled()) {
    await store.append([chain]);
    if (isSkillSuggestionsEnabled()) await chainCache.set(chain);
  }
  await skillSuggestionSurfacing.matchTurn({
    origin: {
      projectId: turn.projectId,
      worktreeId: turn.worktreeId,
      chatId: turn.chatId,
    },
    partition: partition.key,
    turnId: turnMatchId(row),
    chainId: chainMatchId(row),
    shape: row,
    // A turn that invoked no skill cannot complete a chain.
    chain: chain?.skills ?? null,
  });
}

async function loadInventorySkills(): Promise<InventorySkill[]> {
  try {
    const { loadCachedInventory } =
      await import('../plugins/invocable-inventory-service');
    const cache = await loadCachedInventory();
    const seen = new Set<string>();
    const skills: InventorySkill[] = [];
    for (const entry of cache?.entries ?? []) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      skills.push({ name: entry.name, description: entry.description });
    }
    return skills;
  } catch (error) {
    logMainProcessWarn('[skill-suggestions] inventory read failed', error);
    return [];
  }
}

/** Workspace ids that still exist; rows for others are pruned at scan time. */
async function liveWorkspaceIds(): Promise<ReadonlySet<string> | null> {
  try {
    const entries = await readdir(getWorkspacesRootDir(), {
      withFileTypes: true,
    });
    return new Set(
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    );
  } catch {
    return null;
  }
}

/** Chats that still exist; `null` keeps every row when a read fails. */
async function retainedChatIds(
  now: number,
): Promise<ReadonlySet<string> | null> {
  try {
    return await listRetainedChatIds(now);
  } catch (error) {
    logMainProcessWarn('[skill-suggestions] chat listing failed', error);
    return null;
  }
}

const scheduler = new SkillSuggestionScheduler({
  isScanEnabled: isSkillSuggestionScanEnabled,
  hasBusySession: hasActiveChatTurns,
  subscribeActivity: subscribeChatSessionActivity,
  runPass: async ({ slicer }): Promise<void> => {
    const before = await registry.read();
    const waiveMinimum = !before.backfill.done;
    if (!before.backfill.done) {
      const result = await runBackfill({
        store,
        registry,
        slicer,
        now: Date.now,
        isAllowed: isSkillSuggestionScanEnabled,
        ...defaultBackfillSources,
      });
      chainCache.reset();
      if (result === 'cancelled') return;
    }
    await runScanPass(
      {
        store,
        registry,
        slicer,
        now: Date.now,
        isAllowed: isSkillSuggestionScanEnabled,
        readPreferences: readPreferencesFile,
        readOrganizations: readMemberOrganizations,
        loadInventory: loadInventorySkills,
        loadGenerator: () => import('./clustering-generator'),
        liveProjectIds: liveWorkspaceIds,
        liveChatIds: retainedChatIds,
        onPartitionScanned: (outcome, candidateCount) =>
          recordSkillSuggestionTelemetry({
            action: 'scan',
            outcome,
            candidateCount,
          }),
        notifyChanged: () => skillSuggestionSurfacing.notifyChanged(),
      },
      { waiveMinimum },
    );
  },
});

/**
 * Performance seam for the `skill-suggestions-backfill` scenario. Scans never
 * run in E2E builds, so this runs the first-scan backfill and clustering on
 * demand, under the same gate and time slicer as the scheduler, with the model
 * step stubbed out, and reports main event-loop delay. The build-time gate
 * removes it from production.
 */
function installE2eBackfillProbe(): void {
  if (!__CANOPY_E2E__) return;
  Object.defineProperty(
    globalThis,
    '__CANOPY_E2E_RUN_SKILL_SUGGESTION_BACKFILL__',
    {
      configurable: true,
      value: async (): Promise<Record<string, number | string>> => {
        const loopDelay = monitorEventLoopDelay({ resolution: 10 });
        loopDelay.enable();
        const slicer = new TimeSlicer({
          shouldStop: (): boolean =>
            !isSkillSuggestionsEnabled() || hasActiveChatTurns(),
        });
        const startedAt = performance.now();
        try {
          const backfill = await runBackfill({
            store,
            registry,
            slicer,
            now: Date.now,
            isAllowed: isSkillSuggestionsEnabled,
            ...defaultBackfillSources,
          });
          chainCache.reset();
          const backfillMs = performance.now() - startedAt;
          let scannedPartitions = 0;
          let candidateCount = 0;
          const scan =
            backfill === 'done'
              ? await runScanPass(
                  {
                    store,
                    registry,
                    slicer,
                    now: Date.now,
                    isAllowed: isSkillSuggestionsEnabled,
                    readPreferences: readPreferencesFile,
                    readOrganizations: readMemberOrganizations,
                    loadInventory: loadInventorySkills,
                    loadGenerator: async () => ({
                      ...(await import('./clustering-generator')),
                      chooseScanModel: (): Promise<ScanModelChoice> =>
                        Promise.resolve({
                          kind: 'skip',
                          reason: 'performance probe',
                        }),
                    }),
                    liveProjectIds: liveWorkspaceIds,
                    liveChatIds: retainedChatIds,
                    onPartitionScanned: (_outcome, count) => {
                      scannedPartitions += 1;
                      candidateCount += count;
                    },
                    notifyChanged: () =>
                      skillSuggestionSurfacing.notifyChanged(),
                  },
                  { waiveMinimum: true },
                )
              : 'cancelled';
          const rows = await store.read();
          return {
            backfill,
            scan,
            durationMs: performance.now() - startedAt,
            backfillMs,
            turnRows: rows.filter((row) => row.kind === 'turn').length,
            chainRows: rows.filter((row) => row.kind === 'chat_chain').length,
            scannedPartitions,
            candidateCount,
            longestSliceMs: slicer.longestSliceMs,
            sliceYields: slicer.yields,
            eventLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
            eventLoopDelayMaxMs: loopDelay.max / 1e6,
          };
        } finally {
          loopDelay.disable();
        }
      },
    },
  );
}

async function purgeForPreferenceOff(): Promise<void> {
  // A failed fingerprint delete never keeps open suggestions on disk.
  const [cleared, reset] = await Promise.allSettled([
    store.clear(),
    registry.update((draft) => resetForPreferenceOff(draft)),
  ]);
  chainCache.reset();
  skillSuggestionSurfacing.notifyChanged();
  if (cleared.status === 'rejected') throw cleared.reason;
  if (reset.status === 'rejected') throw reset.reason;
}

export interface SkillSuggestionWorkspacePurge {
  fingerprintRowsRemoved: number;
  suggestionsRemoved: number;
  matchesRemoved: number;
}

/** Workspace deletion: drop its rows, private suggestions and matches. */
export async function purgeSkillSuggestionsForWorkspace(
  workspaceId: string,
): Promise<SkillSuggestionWorkspacePurge> {
  let suggestionsRemoved = 0;
  let matchesRemoved = 0;
  let closedIds: string[] = [];
  // A failed fingerprint purge never keeps the workspace's suggestions.
  const [rows, purged] = await Promise.allSettled([
    store.purgeWorkspace(workspaceId),
    registry.update((draft) => {
      const openIds = (): string[] =>
        draft.suggestions
          .filter((entry) => isOpenSuggestion(entry))
          .map((entry) => entry.id);
      const before = openIds();
      const result = purgeWorkspaceFromState(draft, workspaceId, Date.now());
      const after = new Set(openIds());
      // Removed or expired suggestions lose their banners and snapshots.
      closedIds = before.filter((id) => !after.has(id));
      suggestionsRemoved = result.suggestionsRemoved;
      matchesRemoved = result.matchesRemoved;
      return result.suggestionsRemoved + result.matchesRemoved > 0
        ? true
        : false;
    }),
  ]);
  chainCache.reset();
  if (purged.status === 'fulfilled' && purged.value !== false) {
    skillSuggestionSurfacing.dropPendingForSuggestions(closedIds);
    skillSuggestionSurfacing.notifyChanged();
  }
  if (rows.status === 'rejected') throw rows.reason;
  if (purged.status === 'rejected') throw purged.reason;
  return {
    fingerprintRowsRemoved: rows.value,
    suggestionsRemoved,
    matchesRemoved,
  };
}

const originKey = (origin: SkillSuggestionOrigin): string =>
  JSON.stringify([origin.projectId, origin.worktreeId, origin.chatId]);

/** A disposed chat session drops its pending banner, as the share nudge does. */
function clearDisposedSessions(): void {
  const pending = skillSuggestionSurfacing.pendingOrigins();
  if (pending.length === 0) return;
  const live = new Set(
    getAllActiveSessionInfos().map((info) => originKey(info)),
  );
  for (const origin of pending) {
    if (!live.has(originKey(origin))) skillSuggestionSurfacing.clear(origin);
  }
}

const stopFns: Array<() => void> = [];

/** Applies the persisted preference; called at startup and on every save. */
export function applySkillSuggestionsPreference(enabled: boolean): void {
  setSkillSuggestionsPreference(enabled);
}

export function startSkillSuggestions(): void {
  if (stopFns.length > 0) return;
  skillSuggestionTurnRecorder.setSink(handleRecordedTurn);
  stopFns.push(startSkillSuggestionsGate());
  stopFns.push(
    onSkillSuggestionsGateChanged((change) => {
      if (!change.enabled) {
        skillSuggestionTurnRecorder.dropOpenTurns();
        scheduler.cancelInFlight();
        skillSuggestionSurfacing.clearAll();
      }
      if (
        change.cause === 'preference' &&
        !isSkillSuggestionsPreferenceEnabled()
      ) {
        void purgeForPreferenceOff().catch((error: unknown) =>
          logMainProcessWarn(
            '[skill-suggestions] preference purge failed',
            error,
          ),
        );
      }
      if (change.enabled) scheduler.handleActivity();
    }),
  );
  stopFns.push(subscribeChatSessionActivity(clearDisposedSessions));
  scheduler.start();
  stopFns.push(() => scheduler.stop());
  installE2eBackfillProbe();
  void readPreferencesFile()
    .then((preferences) =>
      applySkillSuggestionsPreference(
        preferences.skillSuggestionsEnabled !== false,
      ),
    )
    .catch((error: unknown) =>
      logMainProcessWarn('[skill-suggestions] preference read failed', error),
    );
}

export function stopSkillSuggestions(): void {
  skillSuggestionTurnRecorder.setSink(null);
  skillSuggestionTurnRecorder.dropOpenTurns();
  for (const stop of stopFns.splice(0)) stop();
}
