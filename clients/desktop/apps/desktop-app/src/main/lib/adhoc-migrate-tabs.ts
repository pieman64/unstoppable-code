import { randomUUID } from 'node:crypto';
import {
  getProviderForModel,
  type AgentProviderType,
  type ChatAdhocMigrateTabsRequest,
  type ChatAdhocMigrateTabsResponse,
  type ChatTabsFile,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { forkCodexThreadByIdViaOneShot } from '../codex/fork-thread';
import { normalizeAgentArtifactCarryByTurn } from '@canopy/desktop-shared/lib/agent-artifacts';
import { prepareOpenCodeVisibleFork } from '@canopy/desktop-shared/lib/opencode-fork-context';
import {
  codexSpeedFastMode,
  isCodexSpeed,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/desktop-shared/lib/codex-speed';
import { readChatTabsFile } from './chat-tabs-reader';
import { getChatStateService } from '../services/chat-state-service';
import { resolveWorktreeCwd } from './resolve-worktree';

interface AdhocMigrateTabsDependencies {
  readTabs: typeof readChatTabsFile;
  updateTabs: (
    projectId: string,
    worktreeId: string,
    update: (current: ChatTabsFile) => ChatTabsFile,
  ) => Promise<ChatTabsFile>;
  copyTabs: (
    request: ChatAdhocMigrateTabsRequest,
    data: ChatTabsFile,
    sourceChatIds: Readonly<Record<string, string>>,
  ) => Promise<void>;
  resolveCwd: typeof resolveWorktreeCwd;
  forkCodexThread: typeof forkCodexThreadByIdViaOneShot;
  nextId: () => string;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: AdhocMigrateTabsDependencies = {
  readTabs: readChatTabsFile,
  updateTabs: async (projectId, worktreeId, update) =>
    getChatStateService().updateCompatibilityTabs(
      { projectId, worktreeId },
      update,
    ),
  copyTabs: async (request, data, sourceChatIds) =>
    getChatStateService().copyStorageChats(
      {
        projectId: request.sourceWorkspaceId,
        worktreeId: request.sourceWorktreeId,
      },
      {
        projectId: request.destinationWorkspaceId,
        worktreeId: request.destinationWorktreeId,
      },
      data,
      { version: 1, archived: [] },
      sourceChatIds,
    ),
  resolveCwd: resolveWorktreeCwd,
  forkCodexThread: forkCodexThreadByIdViaOneShot,
  nextId: () => `chat-${randomUUID()}`,
  now: () => new Date(),
};

function rewriteFilePathForMigration(
  filePath: string,
  rewrites: readonly { fromRoot: string; toRoot: string }[],
): string | null {
  for (const rewrite of rewrites) {
    const { fromRoot, toRoot } = rewrite;
    if (!fromRoot) continue;
    if (filePath === fromRoot) {
      return toRoot;
    }
    // Match on a path boundary so `foo/bar` does not match `foo/barbaz`.
    if (
      filePath.startsWith(fromRoot) &&
      (filePath[fromRoot.length] === '/' || filePath[fromRoot.length] === '\\')
    ) {
      return `${toRoot}${filePath.slice(fromRoot.length)}`;
    }
  }
  return null;
}

function splitFilePathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function getFilePathSuffix(filePath: string, segmentCount: number): string {
  return splitFilePathSegments(filePath).slice(-segmentCount).join('/');
}

function buildFileTabTitle(
  filePath: string,
  allFilePaths: readonly string[],
): string {
  const segments = splitFilePathSegments(filePath);
  if (segments.length === 0) {
    return filePath;
  }
  for (
    let segmentCount = 1;
    segmentCount <= segments.length;
    segmentCount += 1
  ) {
    const suffix = getFilePathSuffix(filePath, segmentCount);
    const duplicateCount = allFilePaths.filter(
      (candidatePath) =>
        getFilePathSuffix(candidatePath, segmentCount) === suffix,
    ).length;
    if (duplicateCount === 1) {
      return suffix;
    }
  }
  return filePath;
}

/** Relabel file tabs to the shortest path suffix unique among siblings. */
function relabelPersistedFileTabs(
  tabs: readonly PersistedChatTab[],
): PersistedChatTab[] {
  const filePaths = tabs.flatMap((tab) =>
    tab.kind === 'file' && tab.filePath ? [tab.filePath] : [],
  );
  return tabs.map((tab) => {
    if (tab.kind !== 'file' || !tab.filePath) {
      return tab;
    }
    const title = buildFileTabTitle(tab.filePath, filePaths);
    const description = tab.filePath;
    if (tab.title === title && tab.description === description) {
      return tab;
    }
    return { ...tab, title, description };
  });
}

/**
 * Model settings a migrated chat keeps: its exact requested Codex speed (the
 * deprecated `codexFastModeEnabled` alias folds into `modelConfig.speed` with
 * speed-first precedence) and the Codex speed a non-Codex chat retained. A
 * chat with no recorded speed keeps inheriting the provider default rather
 * than gaining an explicit Regular choice.
 */
function migratedModelSettings(
  source: PersistedChatTab,
  providerType: AgentProviderType | undefined,
): Pick<
  PersistedChatTab,
  'modelConfig' | 'codexFastModeEnabled' | 'retainedCodexSpeed'
> {
  const speed = readCodexSpeedRecord(
    source.modelConfig,
    source.codexFastModeEnabled,
  );
  const modelConfig =
    speed === undefined
      ? source.modelConfig && structuredClone(source.modelConfig)
      : withCodexSpeed(structuredClone(source.modelConfig), speed);
  return {
    ...(modelConfig ? { modelConfig } : {}),
    ...(providerType === 'codex' && speed !== undefined
      ? { codexFastModeEnabled: codexSpeedFastMode(speed) }
      : {}),
    ...(isCodexSpeed(source.retainedCodexSpeed)
      ? { retainedCodexSpeed: source.retainedCodexSpeed }
      : {}),
  };
}

/**
 * Clone a canonical chat tab for placement in the ad-hoc destination. Mirrors
 * the pre-cutover renderer clone policy: carries transcript and configuration
 * plus `adhocMigrationSource` identity, drops delivery/sharing/archive/
 * attention lifecycle, keeps Claude session continuity (forked on next send),
 * and leaves the Codex thread to an explicit fork.
 */
function cloneChatTabForMigration(
  source: PersistedChatTab,
  id: string,
  createdAt: string,
  request: ChatAdhocMigrateTabsRequest,
  selectedRepoId: string | undefined,
): PersistedChatTab {
  const providerType =
    source.providerType ??
    (source.model ? getProviderForModel(source.model) : 'claude');
  const carriedSdkSessionId =
    providerType === 'claude' ? source.sdkSessionId : undefined;
  const messages = source.transcript ? [] : structuredClone(source.messages);
  const forkAnchorMessageId = source.transcript
    ? source.transcript.lastMessageId
    : messages[messages.length - 1]?.id;
  const agentArtifactCarryByTurn = normalizeAgentArtifactCarryByTurn(
    source.agentArtifactCarryByTurn,
    source.transcript
      ? undefined
      : new Set(
          messages
            .filter((message) => message.role === 'user')
            .map((message) => message.id),
        ),
  );
  const cloned: PersistedChatTab = {
    id,
    title: source.title,
    messages,
    createdAt,
    providerType,
    ...(source.description ? { description: source.description } : {}),
    ...(source.model ? { model: source.model } : {}),
    ...(source.planMode !== undefined ? { planMode: source.planMode } : {}),
    ...(source.proposalMode ? { proposalMode: source.proposalMode } : {}),
    ...(source.thinkingLevel ? { thinkingLevel: source.thinkingLevel } : {}),
    ...migratedModelSettings(source, providerType),
    ...(carriedSdkSessionId
      ? { sdkSessionId: carriedSdkSessionId, claudeForkSessionOnNextSend: true }
      : {}),
    forkedFrom: {
      projectId: request.sourceWorkspaceId,
      worktreeId: request.sourceWorktreeId,
      chatId: source.id,
      ...(forkAnchorMessageId ? { atMessageId: forkAnchorMessageId } : {}),
      ...(carriedSdkSessionId ? { resumePointRequired: true } : {}),
      ...(!carriedSdkSessionId &&
      providerType !== 'opencode' &&
      source.forkedFrom?.modelContext === 'fresh'
        ? { modelContext: 'fresh' }
        : {}),
    },
    adhocMigrationSource: {
      projectId: request.sourceWorkspaceId,
      worktreeId: request.sourceWorktreeId,
      tabId: source.id,
    },
    ...(source.pluginSelections
      ? { pluginSelections: structuredClone(source.pluginSelections) }
      : {}),
    ...(agentArtifactCarryByTurn ? { agentArtifactCarryByTurn } : {}),
    ...(source.discovery
      ? { discovery: structuredClone(source.discovery) }
      : {}),
    ...(source.usage ? { usage: structuredClone(source.usage) } : {}),
    ...(source.agentUsage
      ? { agentUsage: structuredClone(source.agentUsage) }
      : {}),
    ...(source.turnDiffs
      ? { turnDiffs: structuredClone(source.turnDiffs) }
      : {}),
    ...(source.pendingPlanExit
      ? { pendingPlanExit: structuredClone(source.pendingPlanExit) }
      : {}),
    ...(source.trackedPlanId ? { trackedPlanId: source.trackedPlanId } : {}),
    ...(source.trackedPlanSource
      ? { trackedPlanSource: source.trackedPlanSource }
      : {}),
    ...(source.trackedPlanReviewStatus
      ? { trackedPlanReviewStatus: source.trackedPlanReviewStatus }
      : {}),
    ...(source.hasOutstandingProposal !== undefined
      ? { hasOutstandingProposal: source.hasOutstandingProposal }
      : {}),
    ...(source.latestRevisionNumber !== undefined
      ? { latestRevisionNumber: source.latestRevisionNumber }
      : {}),
    ...(selectedRepoId ? { selectedRepoId } : {}),
  };
  if (providerType === 'opencode') prepareOpenCodeVisibleFork(cloned);
  return cloned;
}

/**
 * Migrate the canonical tabs of a source worktree into an ad-hoc multi-repo
 * workspace destination. Main owns the whole durable mutation: clone with
 * `adhocMigrationSource` identity, remap repos, rewrite file-tab paths, fork
 * Codex threads, merge without clobbering existing destination tabs, and
 * commit through the chat state service. Re-running the same migration is
 * idempotent (`adhocMigrationSource`/file-path dedupe).
 */
export async function adhocMigrateWorktreeTabs(
  request: ChatAdhocMigrateTabsRequest,
  dependencies: Partial<AdhocMigrateTabsDependencies> = {},
): Promise<ChatAdhocMigrateTabsResponse> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const source = await deps.readTabs(
    request.sourceWorkspaceId,
    request.sourceWorktreeId,
  );
  if (source.tabs.length === 0) {
    return { migratedTabIds: [] };
  }

  // Defensive longest-fromRoot-first sort; the combine backend already
  // guarantees this ordering.
  const rewrites = [...request.filePathRewrites].sort(
    (a, b) => b.fromRoot.length - a.fromRoot.length,
  );

  const createdAt = deps.now().toISOString();
  const idMap = new Map<string, string>();
  let migratedTabs: PersistedChatTab[] = [];
  const codexForks: Array<{
    tab: PersistedChatTab;
    sourceTab: PersistedChatTab;
  }> = [];

  for (const sourceTab of source.tabs) {
    if (sourceTab.kind === 'file') {
      if (!sourceTab.filePath) continue;
      const nextPath = rewriteFilePathForMigration(
        sourceTab.filePath,
        rewrites,
      );
      if (nextPath === null) continue;
      const clonedFile: PersistedChatTab = {
        ...structuredClone(sourceTab),
        id: deps.nextId(),
        filePath: nextPath,
        description: nextPath,
        // Relabelled to the unique suffix among destination siblings below.
        title: nextPath,
        messages: [],
      };
      idMap.set(sourceTab.id, clonedFile.id);
      migratedTabs.push(clonedFile);
      continue;
    }

    // Root-scoped single-repo chats map to the moved child repo, not the
    // destination workspace root; the backend marks that case explicitly.
    const remappedSelectedRepoId =
      sourceTab.selectedRepoId !== undefined
        ? (request.selectedRepoIdRewrites[sourceTab.selectedRepoId] ??
          sourceTab.selectedRepoId)
        : request.sourceRootRepoIdRewrite;
    const cloned = cloneChatTabForMigration(
      sourceTab,
      deps.nextId(),
      createdAt,
      request,
      remappedSelectedRepoId,
    );
    idMap.set(sourceTab.id, cloned.id);
    migratedTabs.push(cloned);
    if (
      (sourceTab.providerType ??
        (sourceTab.model ? getProviderForModel(sourceTab.model) : 'claude')) ===
        'codex' &&
      sourceTab.sdkSessionId
    ) {
      codexForks.push({ tab: cloned, sourceTab });
    }
  }

  // Merge into any existing destination state instead of replacing it. The
  // join-existing flow runs this migration twice into the same destination,
  // so dedupe by id, file path, and adhoc-migration identity.
  const destination = await deps.readTabs(
    request.destinationWorkspaceId,
    request.destinationWorktreeId,
  );
  const existingTabIds = new Set(destination.tabs.map((tab) => tab.id));
  const existingFilePaths = new Set(
    destination.tabs.flatMap((tab) =>
      tab.kind === 'file' && tab.filePath ? [tab.filePath] : [],
    ),
  );
  const existingMigrationSources = new Set(
    destination.tabs.flatMap((tab) =>
      tab.kind !== 'file' && tab.adhocMigrationSource
        ? [
            `${tab.adhocMigrationSource.projectId}/${tab.adhocMigrationSource.worktreeId}/${tab.adhocMigrationSource.tabId}`,
          ]
        : [],
    ),
  );
  migratedTabs = migratedTabs.filter((tab) => {
    if (existingTabIds.has(tab.id)) return false;
    if (tab.kind === 'file' && tab.filePath) {
      return !existingFilePaths.has(tab.filePath);
    }
    if (tab.kind !== 'file' && tab.adhocMigrationSource) {
      const key = `${tab.adhocMigrationSource.projectId}/${tab.adhocMigrationSource.worktreeId}/${tab.adhocMigrationSource.tabId}`;
      return !existingMigrationSources.has(key);
    }
    return true;
  });
  if (migratedTabs.length === 0) {
    return { migratedTabIds: [] };
  }

  // A migrated Codex tab must not become sendable until its continuation has
  // either been forked or definitively fallen back to a fresh session.
  const appendedIds = new Set(migratedTabs.map((tab) => tab.id));
  await Promise.all(
    codexForks
      .filter((fork) => appendedIds.has(fork.tab.id))
      .map(async ({ tab, sourceTab }): Promise<void> => {
        if (!sourceTab.sdkSessionId) return;
        try {
          tab.sdkSessionId = await deps.forkCodexThread({
            cwd: deps.resolveCwd(
              request.destinationWorkspaceId,
              request.destinationWorktreeId,
              tab.selectedRepoId,
            ),
            projectId: request.destinationWorkspaceId,
            worktreeId: request.destinationWorktreeId,
            chatId: tab.id,
            sourceThreadId: sourceTab.sdkSessionId,
            sourceProjectId: request.sourceWorkspaceId,
            sourceWorktreeId: request.sourceWorktreeId,
            sourceChatId: sourceTab.id,
            ...(tab.pluginSelections
              ? { pluginSelections: tab.pluginSelections }
              : {}),
            ...(tab.modelConfig ? { modelConfig: tab.modelConfig } : {}),
            codexFastModeEnabled: tab.codexFastModeEnabled,
          });
        } catch {
          // The transcript still transfers; the destination starts a fresh
          // Codex thread on its next turn.
          delete tab.sdkSessionId;
        }
      }),
  );

  const migratedActiveTabId = source.activeTabId
    ? idMap.get(source.activeTabId)
    : undefined;
  if (source.tabs.some((tab) => tab.transcript)) {
    const activeTabId =
      destination.activeTabId || migratedActiveTabId || migratedTabs[0].id;
    await deps.copyTabs(
      request,
      { version: 1, tabs: migratedTabs, activeTabId },
      Object.fromEntries(
        Array.from(idMap.entries())
          .filter(([, to]) => migratedTabs.some((tab) => tab.id === to))
          .map(([from, to]) => [to, from]),
      ),
    );
    await deps.updateTabs(
      request.destinationWorkspaceId,
      request.destinationWorktreeId,
      (latest) => ({ ...latest, tabs: relabelPersistedFileTabs(latest.tabs) }),
    );
    return { migratedTabIds: migratedTabs.map((tab) => tab.id) };
  }
  let committedTabIds: string[] = [];
  await deps.updateTabs(
    request.destinationWorkspaceId,
    request.destinationWorktreeId,
    (latestDestination) => {
      const latestSources = new Set(
        latestDestination.tabs.flatMap((tab) =>
          tab.adhocMigrationSource
            ? [
                `${tab.adhocMigrationSource.projectId}/${tab.adhocMigrationSource.worktreeId}/${tab.adhocMigrationSource.tabId}`,
              ]
            : [],
        ),
      );
      const latestFilePaths = new Set(
        latestDestination.tabs.flatMap((tab) =>
          tab.kind === 'file' && tab.filePath ? [tab.filePath] : [],
        ),
      );
      const tabsToAdd = migratedTabs.filter((tab) => {
        if (tab.kind === 'file' && tab.filePath) {
          return !latestFilePaths.has(tab.filePath);
        }
        if (tab.adhocMigrationSource) {
          const sourceKey = `${tab.adhocMigrationSource.projectId}/${tab.adhocMigrationSource.worktreeId}/${tab.adhocMigrationSource.tabId}`;
          return !latestSources.has(sourceKey);
        }
        return true;
      });
      committedTabIds = tabsToAdd.map(({ id }) => id);
      const mergedTabs = relabelPersistedFileTabs([
        ...latestDestination.tabs,
        ...tabsToAdd,
      ]);
      const activeTabId =
        [
          latestDestination.activeTabId,
          migratedActiveTabId,
          tabsToAdd[tabsToAdd.length - 1]?.id,
          mergedTabs[0]?.id,
        ].find(
          (candidateId) =>
            candidateId !== undefined &&
            candidateId !== '' &&
            mergedTabs.some((tab) => tab.id === candidateId),
        ) ?? '';
      return {
        version: 1,
        tabs: mergedTabs,
        activeTabId,
        ...(latestDestination.lastActiveEditableChatId &&
        mergedTabs.some(
          (tab) => tab.id === latestDestination.lastActiveEditableChatId,
        )
          ? {
              lastActiveEditableChatId:
                latestDestination.lastActiveEditableChatId,
            }
          : {}),
        ...((latestDestination.lastActiveChatProvider ??
        source.lastActiveChatProvider)
          ? {
              lastActiveChatProvider:
                latestDestination.lastActiveChatProvider ??
                source.lastActiveChatProvider,
            }
          : {}),
        ...(latestDestination.pendingQuestions
          ? { pendingQuestions: latestDestination.pendingQuestions }
          : {}),
      };
    },
  );
  return { migratedTabIds: committedTabIds };
}
