import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  COWORK_HOME_WORKTREE_ID,
  type AppAdvisorUiStateSnapshot,
  type ChatStateSnapshot,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { listAttachmentsForIpc } from '../canopy-runtime/workspace-item-attachments-dispatch';
import {
  listTextItemsForIpc,
  readTextItemForIpc,
} from '../canopy-runtime/workspace-item-notes-dispatch';
import { readCollectionIndex } from '../collections/collection-store';
import { getActiveChatIds } from '../agents/session-manager';
import { toArchivedChatSummary } from '../lib/chat-archives';
import { serializeChatProjectOperation } from '../lib/chat-project-operation-queue';
import { listWorkEntries } from '../lib/cowork-work-entries';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { validateAbsolutePath } from '../lib/validation';
import {
  listChatProjects,
  loadChatProjectClaudeMd,
} from '../ipc/chat-projects';
import { readLocalFileContent } from '../ipc/file-preview';
import { readMcpServersIndexForPresentation } from '../ipc/mcp-servers';
import {
  initStandaloneChat,
  listChats,
  loadWorkspace,
  readArchive,
} from '../ipc/standalone-chat';
import { assertWorkEntryWorkspace } from '../ipc/work-entries';
import { loadMarketplacesForPresentation } from '../plugins/plugin-service';
import { projectRuntimeEvidence } from '../project-discovery/runtime-state';
import { getChatStateService } from '../services/chat-state-service';
import { sidebarItemGroupsService } from '../services/sidebar-item-groups-service';
import {
  annotateSharedSkillInstalls,
  filterStoredSkillContexts,
} from '../skills/skill-install-context';
import { loadSkills } from '../skills/skill-service';
import type {
  AdvisorChatReadHost,
  AdvisorStoredChatTab,
} from './advisor-chat-reads';

/** Pages before a transcript read stops; each page holds at most 100 rows. */
const MAX_TRANSCRIPT_PAGES = 1_000;

/**
 * App Advisor's identity for the core reads its chat reads make, carrying
 * only the read grant each call needs.
 */
function advisorReadCaller(
  chatId: string,
  grant: CanopyCallerDescriptor['grants'][number],
): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: `agent-action:${chatId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants: [grant],
  };
}

function tabStatus(
  snapshot: ChatStateSnapshot,
  chatId: string,
): AdvisorStoredChatTab['status'] {
  const { runtimeState } = projectRuntimeEvidence(snapshot, chatId);
  return runtimeState === 'running'
    ? 'streaming'
    : runtimeState === 'error'
      ? 'error'
      : 'idle';
}

/**
 * The main owners behind App Advisor's moved chat reads (CAN-5999), the same
 * ones the window's IPC handlers call. `readUiState` reads the main window's
 * current UI state through its lease and answers null without one.
 */
export function mainAdvisorChatReadHost(options: {
  chatId: string;
  readUiState: () => Promise<AppAdvisorUiStateSnapshot | null>;
}): AdvisorChatReadHost {
  const chatCaller = advisorReadCaller(options.chatId, 'core.chat.read');
  const itemCaller = advisorReadCaller(options.chatId, 'core.workspace.read');
  return {
    readUiState: options.readUiState,
    readTabs: async (projectId, worktreeId) => {
      const { legacyResult: snapshot } =
        await getActiveDesktopRuntime().queryChatStateForLegacyIpc(
          {
            scope: {
              workspaceId: resolveCoworkWorkspaceId(projectId),
              worktreeId,
            },
          },
          { caller: chatCaller },
        );
      if (snapshot.recoveryError !== undefined)
        throw new Error('The chat state could not be read.');
      return {
        activeTabId: snapshot.tabsFile.activeTabId,
        tabs: snapshot.tabsFile.tabs.map((tab) => ({
          ...tab,
          status: tabStatus(snapshot, tab.id),
          queuedMessages: snapshot.queue
            .filter((event) => event.chatId === tab.id)
            .flatMap((event) => event.queue),
        })),
      };
    },
    readRecentMessages: async (projectId, worktreeId, chatId) =>
      (
        await getActiveDesktopRuntime().queryChatTranscriptPageForLegacyIpc(
          {
            scope: {
              workspaceId: resolveCoworkWorkspaceId(projectId),
              worktreeId,
              chatId,
            },
          },
          { caller: chatCaller },
        )
      ).legacyResult.messages,
    readMessages: async (projectId, worktreeId, chatId) => {
      const runtime = getActiveDesktopRuntime();
      const scope = {
        workspaceId: resolveCoworkWorkspaceId(projectId),
        worktreeId,
        chatId,
      };
      let page = (
        await runtime.queryChatTranscriptPageForLegacyIpc(
          { scope },
          { caller: chatCaller },
        )
      ).legacyResult;
      let messages: PersistedChatMessage[] = page.messages;
      for (
        let pages = 1;
        page.before !== undefined && pages < MAX_TRANSCRIPT_PAGES;
        pages += 1
      ) {
        const before = page.before;
        page = (
          await runtime.queryChatTranscriptPageForLegacyIpc(
            { scope, before, transcriptRevision: page.transcriptRevision },
            { caller: chatCaller },
          )
        ).legacyResult;
        if (page.before === before)
          throw new Error('Transcript pagination did not advance.');
        messages = [...page.messages, ...messages];
      }
      return messages;
    },
    readPluginInventories: async () => {
      const skills = loadSkills();
      const [annotated, marketplaces, collections, mcp] = await Promise.all([
        skills.success && skills.data
          ? annotateSharedSkillInstalls(
              await filterStoredSkillContexts(skills.data),
            )
          : Promise.resolve(undefined),
        loadMarketplacesForPresentation(),
        readCollectionIndex(),
        readMcpServersIndexForPresentation(),
      ]);
      return {
        skills: annotated ? { ...skills, data: annotated } : skills,
        marketplaces,
        collections: collections.collections,
        mcp,
      };
    },
    listChatProjects: async () =>
      (await serializeChatProjectOperation(listChatProjects)).projects,
    prepareCoworkProject: (projectId) => initStandaloneChat(projectId),
    locateCoworkChat: async (projectId, chatId) => {
      const located = await getActiveDesktopRuntime().query(
        'core.chat.locate',
        { scope: { workspaceId: assertWorkEntryWorkspace(projectId) }, chatId },
        { caller: chatCaller },
      );
      return {
        entryId: located.worktreeId,
        archivedInEntryId: located.archivedInWorktreeId,
      };
    },
    readArchivedChat: async (projectId, worktreeId, chatId) => {
      const entry = await getChatStateService().readCompatibilityArchive(
        { projectId, worktreeId },
        chatId,
        true,
      );
      if (!entry) throw new Error('Archived chat not found');
      return entry.tab;
    },
    readLegacyArchivedChat: async (projectId, chatId) =>
      (await readArchive({ projectId, chatId })).snapshot?.tab ?? null,
    listWorkEntryIds: async (projectId) =>
      (
        await listWorkEntries(assertWorkEntryWorkspace(projectId), {
          getActiveChatIds,
        })
      ).map((entry) => entry.id),
    listArchives: async (projectId, worktreeId) => {
      const file = await getChatStateService().getCompatibilityArchives({
        projectId,
        worktreeId,
      });
      const now = Date.now();
      return file.archived.map((entry) => toArchivedChatSummary(entry, now));
    },
    listLegacyChats: async (projectId) => (await listChats(projectId)).chats,
    listSidebarGroups: (projectId) =>
      sidebarItemGroupsService.list({ workspaceLocalId: projectId }),
    listProjectArchiveIds: async (projectId) =>
      (await loadWorkspace({ projectId })).archives.map(
        (archive) => archive.chatId,
      ),
    listNotes: (projectId) =>
      listTextItemsForIpc(
        getActiveDesktopRuntime(),
        itemCaller,
        'note',
        projectId,
      ),
    readNote: (projectId, noteId) =>
      readTextItemForIpc(
        getActiveDesktopRuntime(),
        itemCaller,
        'note',
        projectId,
        noteId,
      ),
    listPrompts: (projectId) =>
      listTextItemsForIpc(
        getActiveDesktopRuntime(),
        itemCaller,
        'prompt',
        projectId,
      ),
    readPrompt: (projectId, promptId) =>
      readTextItemForIpc(
        getActiveDesktopRuntime(),
        itemCaller,
        'prompt',
        projectId,
        promptId,
      ),
    // Cowork attachments are shared across Work Entries, so the window lists
    // them under the shared home bucket.
    listAttachments: (projectId) =>
      listAttachmentsForIpc(
        getActiveDesktopRuntime(),
        itemCaller,
        projectId,
        COWORK_HOME_WORKTREE_ID,
      ),
    readFileContent: (absolutePath) => {
      validateAbsolutePath(absolutePath, 'absolutePath');
      return readLocalFileContent(absolutePath);
    },
    readCoworkClaudeMd: async (projectId) =>
      (
        await serializeChatProjectOperation(() =>
          loadChatProjectClaudeMd(projectId),
        )
      ).content,
  };
}
