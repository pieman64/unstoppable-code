import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import {
  CHAT_HISTORY_DEFAULT_LIMIT,
  STANDALONE_LIST_DEFAULT_LIMIT,
  STANDALONE_LIST_MAX_LIMIT,
  availablePluginListResult,
  chatHistoryPayload,
  chatSessionResult,
  chatTabStripLabel,
  clampChatHistoryLimit,
  clampLimit,
  emptyChatTabPluginSelections,
  fuzzyMatchText,
  standaloneChatSummary,
  standaloneProjectSummary,
  standaloneWorkspaceListResult,
  worktreeTabsResult,
  type AdvisorChatHistoryTarget,
  type AdvisorChatTab,
  type AdvisorPluginInventories,
  type ChatHistoryMode,
} from '@canopy/desktop-shared/lib/app-advisor-chat-reads';
import { sidebarItemGroupIds } from '@canopy/desktop-shared/lib/sidebar-item-group-actions';
import {
  COWORK_HOME_WORKTREE_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  isDefaultCoworkWorkspaceId,
  PIPELINE_EDITOR_WORKTREE_ID,
  type AppAdvisorAction,
  type AppAdvisorActionError,
  type AppAdvisorActionResponse,
  type AppAdvisorJson,
  type AppAdvisorUiStateSnapshot,
  type ArchivedChatSummary,
  type ChatProjectData,
  type PersistedChatMessage,
  type PersistedChatTab,
  type StandaloneChatMeta,
} from '@canopy/desktop-shared/types';
import { z } from 'zod';
import { validateId } from '../lib/validation';

/*
 * CAN-5999: App Advisor's chat history, tab, plugin, Cowork project and
 * workspace item reads, in Electron main. Each answers as the renderer
 * dispatcher did, through the shared result builders, from main's stored
 * tabs, transcripts and runtime state. A target the action leaves out is
 * the one the main window shows, read through its lease; with no lease the
 * read is refused, never guessed.
 */

export const ADVISOR_CHAT_READ_ACTION_TYPES = [
  'worktree-chat.list_tabs',
  'worktree-chat.read_history',
  'worktree-chat.get_last_user_message',
  'worktree-chat.get_last_agent_response',
  'worktree-chat.list_plugins',
  'pipeline-assistant-chat.list_tabs',
  'pipeline-assistant-chat.read_history',
  'pipeline-assistant-chat.get_last_user_message',
  'pipeline-assistant-chat.get_last_agent_response',
  'pipeline-assistant-chat.list_plugins',
  'standalone-chat.list_projects',
  'standalone-chat.list_chats',
  'standalone-chat.get_settings',
  'standalone-chat.list_plugins',
  'standalone-chat.read_history',
  'standalone-chat.get_last_user_message',
  'standalone-chat.get_last_agent_response',
  'standalone-chat.list_prompts',
  'standalone-chat.get_prompt',
  'standalone-chat.list_notes',
  'standalone-chat.get_note',
  'standalone-chat.list_attachments',
  'standalone-chat.get_attachment',
] as const;

type AdvisorChatReadType = (typeof ADVISOR_CHAT_READ_ACTION_TYPES)[number];

export type AdvisorChatReadAction = Extract<
  AppAdvisorAction,
  { type: AdvisorChatReadType }
>;

type ActionOf<T extends AdvisorChatReadType> = Extract<
  AdvisorChatReadAction,
  { type: T }
>;

export function isAdvisorChatReadAction(action: {
  type: string;
}): action is AdvisorChatReadAction {
  return ADVISOR_CHAT_READ_ACTION_TYPES.some((type) => type === action.type);
}

/** A stored tab with the chat's runtime status and queued messages. */
export type AdvisorStoredChatTab = PersistedChatTab & AdvisorChatTab;

export interface AdvisorWorkspaceAttachment {
  filename: string;
  absolutePath: string;
}

/** The main owners these reads use; tests replace them. */
export interface AdvisorChatReadHost {
  /** The main window's UI state through its lease; null with no lease. */
  readUiState(): Promise<AppAdvisorUiStateSnapshot | null>;
  /** A scope's stored tabs; null when the scope has no chat state. */
  readTabs(
    projectId: string,
    worktreeId: string,
  ): Promise<{ activeTabId: string; tabs: AdvisorStoredChatTab[] } | null>;
  /** A chat's latest transcript page, oldest first. */
  readRecentMessages(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): Promise<PersistedChatMessage[]>;
  /** A chat's whole transcript, oldest first. */
  readMessages(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): Promise<PersistedChatMessage[]>;
  readPluginInventories(): Promise<AdvisorPluginInventories>;
  listChatProjects(): Promise<ChatProjectData[]>;
  /** Prepares a Cowork project for reads, as the window's init does. */
  prepareCoworkProject(projectId: string): Promise<void>;
  locateCoworkChat(
    projectId: string,
    chatId: string,
  ): Promise<{ entryId: string | null; archivedInEntryId: string | null }>;
  /** An archived chat with its whole transcript. */
  readArchivedChat(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): Promise<PersistedChatTab>;
  /** A chat archived before Work Entries; null when there is none. */
  readLegacyArchivedChat(
    projectId: string,
    chatId: string,
  ): Promise<PersistedChatTab | null>;
  listWorkEntryIds(projectId: string): Promise<string[]>;
  listArchives(
    projectId: string,
    worktreeId: string,
  ): Promise<ArchivedChatSummary[]>;
  listLegacyChats(projectId: string): Promise<StandaloneChatMeta[]>;
  listSidebarGroups(projectId: string): Promise<SidebarItemGroup[]>;
  /** Chat ids the Cowork project's own archive lists. */
  listProjectArchiveIds(projectId: string): Promise<string[]>;
  listNotes(projectId: string): Promise<Array<{ id: string; title: string }>>;
  readNote(projectId: string, noteId: string): Promise<unknown>;
  listPrompts(projectId: string): Promise<Array<{ id: string; title: string }>>;
  readPrompt(projectId: string, promptId: string): Promise<unknown>;
  listAttachments(projectId: string): Promise<AdvisorWorkspaceAttachment[]>;
  /** A listed attachment's content, as the window's file read answers. */
  readFileContent(absolutePath: string): Promise<unknown>;
  readCoworkClaudeMd(projectId: string): Promise<string>;
}

type Outcome = Omit<AppAdvisorActionResponse, 'requestId'>;

export interface ScopeTarget {
  projectId: string;
  worktreeId: string;
}

export type ChatTarget = ScopeTarget & {
  chatId: string;
  tab: AdvisorStoredChatTab;
};

function failure(error: AppAdvisorActionError): Outcome {
  return { ok: false, error };
}

function ok(result: AppAdvisorJson): Outcome {
  return { ok: true, result };
}

function jsonValue(value: unknown): AppAdvisorJson {
  return z.json().parse(JSON.parse(JSON.stringify(value ?? null)));
}

const NO_WORKTREE_SELECTED = (withChat: boolean): AppAdvisorActionError => ({
  code: 'surface_unavailable',
  message: withChat
    ? 'No worktree is selected. Provide projectId/worktreeId/chatId or select a worktree first.'
    : 'No worktree is selected. Provide projectId/worktreeId or select a worktree first.',
  retryable: true,
});

const NO_COWORK_PROJECT_SELECTED: AppAdvisorActionError = {
  code: 'surface_unavailable',
  message: 'No Cowork project is selected. Provide projectId.',
  retryable: true,
};

/** Both ids from the action, or the worktree the main window shows. */
export async function resolveScope(
  action: { projectId?: string; worktreeId?: string },
  host: Pick<AdvisorChatReadHost, 'readUiState'>,
  withChat: boolean,
): Promise<ScopeTarget | { error: AppAdvisorActionError }> {
  if (action.projectId && action.worktreeId)
    return { projectId: action.projectId, worktreeId: action.worktreeId };
  const selected = (await host.readUiState())?.selectedWorktree;
  if (!selected?.projectId || !selected.worktreeId)
    return { error: NO_WORKTREE_SELECTED(withChat) };
  return { projectId: selected.projectId, worktreeId: selected.worktreeId };
}

async function readScopeTabs(
  scope: ScopeTarget,
  host: Pick<AdvisorChatReadHost, 'readTabs'>,
): Promise<
  | { activeTabId: string; tabs: AdvisorStoredChatTab[] }
  | { error: AppAdvisorActionError }
> {
  const state = await host.readTabs(scope.projectId, scope.worktreeId);
  return (
    state ?? {
      error: {
        code: 'not_found',
        message: `No chat state found for worktree ${scope.projectId}/${scope.worktreeId}.`,
      },
    }
  );
}

/** The chat the action names, or the scope's active tab. */
export async function resolveChatTarget(
  scope: ScopeTarget,
  chatId: string | undefined,
  host: Pick<AdvisorChatReadHost, 'readTabs'>,
): Promise<ChatTarget | { error: AppAdvisorActionError }> {
  const state = await readScopeTabs(scope, host);
  if ('error' in state) return state;
  const id = chatId ?? state.activeTabId;
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (!tab)
    return {
      error: {
        code: 'not_found',
        message: `Chat tab ${id || '(active)'} was not found.`,
      },
    };
  if (tab.kind === 'file')
    return {
      error: {
        code: 'invalid_target',
        message: 'The target tab is a file tab, not a chat transcript.',
      },
    };
  return { ...scope, chatId: id, tab };
}

async function withTranscript(
  target: ChatTarget,
  host: AdvisorChatReadHost,
): Promise<ChatTarget> {
  // A tab with no transcript descriptor keeps its messages inline.
  if (!target.tab.transcript) return target;
  return {
    ...target,
    tab: {
      ...target.tab,
      messages: await host.readMessages(
        target.projectId,
        target.worktreeId,
        target.chatId,
      ),
    },
  };
}

function historyMode(type: string): ChatHistoryMode {
  return type.endsWith('.get_last_user_message')
    ? 'last_user_message'
    : type.endsWith('.get_last_agent_response')
      ? 'last_agent_response'
      : 'transcript';
}

function historyResult(
  action: { type: string; query?: string; limit?: number },
  target: AdvisorChatHistoryTarget,
): Outcome {
  const mode = historyMode(action.type);
  const transcript = mode === 'transcript';
  return ok(
    chatHistoryPayload(
      target,
      mode,
      transcript ? action.query?.trim() : undefined,
      transcript
        ? clampChatHistoryLimit(action.limit)
        : CHAT_HISTORY_DEFAULT_LIMIT,
    ),
  );
}

/**
 * Whether a file tab has unsaved edits. Only an open window holds editor
 * buffers: with no lease nothing is unsaved, and a list the window had to
 * shorten cannot say (null).
 */
function unsavedChangesLookup(
  ui: AppAdvisorUiStateSnapshot | null,
): (tabId: string) => boolean | null {
  if (!ui) return () => false;
  const dirty: unknown = ui.dirtyFileTabIds;
  if (!Array.isArray(dirty)) return () => null;
  const ids = new Set(dirty.filter((id) => typeof id === 'string'));
  return (tabId) => ids.has(tabId);
}

async function listTabs(
  scope: ScopeTarget,
  host: AdvisorChatReadHost,
): Promise<Outcome> {
  const state = await readScopeTabs(scope, host);
  if ('error' in state) return failure(state.error);
  // The stored state carries messages only for the active tab; each other
  // chat's latest page gives its last user message.
  const tabs = await Promise.all(
    state.tabs.map(async (tab) =>
      (tab.kind ?? 'chat') === 'chat' &&
      tab.transcript &&
      tab.messages.length === 0
        ? {
            ...tab,
            messages: await host.readRecentMessages(
              scope.projectId,
              scope.worktreeId,
              tab.id,
            ),
          }
        : tab,
    ),
  );
  const unsaved = state.tabs.some((tab) => tab.kind === 'file')
    ? unsavedChangesLookup(await host.readUiState())
    : (): boolean => false;
  return ok(
    worktreeTabsResult(
      scope.projectId,
      scope.worktreeId,
      tabs,
      state.activeTabId,
      unsaved,
    ),
  );
}

async function pluginList(
  action: ActionOf<
    | 'worktree-chat.list_plugins'
    | 'pipeline-assistant-chat.list_plugins'
    | 'standalone-chat.list_plugins'
  >,
  selections: PersistedChatTab['pluginSelections'] | null,
  targetMeta: AppAdvisorJson | null,
  host: AdvisorChatReadHost,
): Promise<Outcome> {
  return ok(
    availablePluginListResult(
      await host.readPluginInventories(),
      selections ?? null,
      targetMeta,
      action,
    ),
  );
}

async function worktreePluginList(
  action: ActionOf<'worktree-chat.list_plugins'>,
  host: AdvisorChatReadHost,
): Promise<Outcome> {
  const explicit =
    action.projectId !== undefined ||
    action.worktreeId !== undefined ||
    action.chatId !== undefined;
  // With no target and nothing selected, the list shows no current selection.
  let scope: ScopeTarget | { error: AppAdvisorActionError } = {
    error: NO_WORKTREE_SELECTED(true),
  };
  if (explicit) scope = await resolveScope(action, host, true);
  else {
    const selected = (await host.readUiState())?.selectedWorktree;
    if (selected?.projectId && selected.worktreeId)
      scope = {
        projectId: selected.projectId,
        worktreeId: selected.worktreeId,
      };
  }
  if ('error' in scope) {
    if (explicit) return failure(scope.error);
    return pluginList(action, null, null, host);
  }
  const target = await resolveChatTarget(scope, action.chatId, host);
  if ('error' in target) {
    if (explicit) return failure(target.error);
    return pluginList(action, null, null, host);
  }
  return pluginList(
    action,
    target.tab.pluginSelections ?? emptyChatTabPluginSelections(),
    {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      title: target.tab.title,
      session: chatSessionResult(target.tab),
    },
    host,
  );
}

export const PIPELINE_ASSISTANT: ScopeTarget = {
  projectId: PIPELINE_EDITOR_PROJECT_ID,
  worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
};

async function readPipelineAssistantTabs(
  host: AdvisorChatReadHost,
): Promise<
  | { activeTabId: string; tabs: AdvisorStoredChatTab[] }
  | { error: AppAdvisorActionError }
> {
  const state = await host.readTabs(
    PIPELINE_ASSISTANT.projectId,
    PIPELINE_ASSISTANT.worktreeId,
  );
  return (
    state ?? {
      error: {
        code: 'not_found',
        message: 'No Pipeline Assistant chat state was found.',
      },
    }
  );
}

async function pipelineAssistantRead(
  action: ActionOf<
    | 'pipeline-assistant-chat.list_tabs'
    | 'pipeline-assistant-chat.read_history'
    | 'pipeline-assistant-chat.get_last_user_message'
    | 'pipeline-assistant-chat.get_last_agent_response'
    | 'pipeline-assistant-chat.list_plugins'
  >,
  host: AdvisorChatReadHost,
): Promise<Outcome> {
  const loaded = await readPipelineAssistantTabs(host);
  if ('error' in loaded) return failure(loaded.error);
  if (action.type === 'pipeline-assistant-chat.list_tabs')
    return listTabs(PIPELINE_ASSISTANT, host);
  const target = await resolveChatTarget(
    PIPELINE_ASSISTANT,
    action.chatId,
    host,
  );
  if ('error' in target) return failure(target.error);
  if (action.type === 'pipeline-assistant-chat.list_plugins')
    return pluginList(
      action,
      target.tab.pluginSelections ?? emptyChatTabPluginSelections(),
      {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
        title: target.tab.title,
        session: chatSessionResult(target.tab),
      },
      host,
    );
  return historyResult(action, await withTranscript(target, host));
}

async function findCoworkProject(
  projectId: string,
  host: AdvisorChatReadHost,
): Promise<ChatProjectData | { error: AppAdvisorActionError }> {
  const project = (await host.listChatProjects()).find(
    (candidate) => candidate.id === projectId,
  );
  return (
    project ?? {
      error: {
        code: 'not_found',
        message: `Cowork project ${projectId} was not found.`,
      },
    }
  );
}

/** The project the action names, or the one the main window's Chats section shows. */
async function resolveCoworkProjectId(
  projectId: string | undefined,
  host: AdvisorChatReadHost,
): Promise<string | { error: AppAdvisorActionError }> {
  const resolved =
    projectId ?? (await host.readUiState())?.activeCoworkProjectId;
  if (!resolved) return { error: NO_COWORK_PROJECT_SELECTED };
  const project = await findCoworkProject(resolved, host);
  if ('error' in project) return project;
  return resolved;
}

function archivedTab(tab: PersistedChatTab): AdvisorStoredChatTab {
  return { ...tab, status: 'idle', queuedMessages: [] };
}

/** A Cowork chat in its Work Entry, archive or legacy archive. */
async function resolveCoworkChat(
  projectId: string,
  chatId: string,
  host: AdvisorChatReadHost,
): Promise<ChatTarget | { error: AppAdvisorActionError }> {
  await host.prepareCoworkProject(projectId);
  const located = await host.locateCoworkChat(projectId, chatId);
  if (located.archivedInEntryId !== null) {
    const tab = await host.readArchivedChat(
      projectId,
      located.archivedInEntryId,
      chatId,
    );
    return {
      projectId,
      worktreeId: located.archivedInEntryId,
      chatId,
      tab: archivedTab(tab),
    };
  }
  const worktreeId = located.entryId ?? COWORK_HOME_WORKTREE_ID;
  const target = await resolveChatTarget(
    { projectId, worktreeId },
    chatId,
    host,
  );
  if ('error' in target) {
    const legacy = await host
      .readLegacyArchivedChat(projectId, chatId)
      .catch(() => null);
    if (legacy)
      return {
        projectId,
        worktreeId: COWORK_HOME_WORKTREE_ID,
        chatId,
        tab: archivedTab(legacy),
      };
    return {
      error: {
        ...target.error,
        message: `Standalone chat ${chatId} in project ${projectId} could not be resolved: ${target.error.message}`,
      },
    };
  }
  return withTranscript(target, host);
}

async function listCoworkProjects(
  action: ActionOf<'standalone-chat.list_projects'>,
  host: AdvisorChatReadHost,
): Promise<Outcome> {
  const includeDefault = action.includeDefault !== false;
  const projects = (await host.listChatProjects()).filter(
    (project) => includeDefault || !isDefaultCoworkWorkspaceId(project.id),
  );
  const max = clampLimit(
    action.limit,
    STANDALONE_LIST_DEFAULT_LIMIT,
    STANDALONE_LIST_MAX_LIMIT,
  );
  const matching = projects.filter((project) =>
    fuzzyMatchText(action.query, [
      project.id,
      project.name,
      project.description ?? '',
    ]),
  );
  const selected = matching.slice(0, max);
  return ok({
    query: action.query?.trim() ?? '',
    includeDefault,
    activeProjectId: (await host.readUiState())?.activeCoworkProjectId ?? null,
    totalMatches: matching.length,
    returned: selected.length,
    projects: selected.map(standaloneProjectSummary),
  });
}

async function listCoworkChats(
  action: ActionOf<'standalone-chat.list_chats'>,
  host: AdvisorChatReadHost,
): Promise<Outcome> {
  const resolved = await resolveCoworkProjectId(action.projectId, host);
  if (typeof resolved !== 'string') return failure(resolved.error);
  const entryIds = await host.listWorkEntryIds(resolved);
  const memberships = sidebarItemGroupIds(
    await host.listSidebarGroups(resolved),
    entryIds.map((id) => [id]),
  );
  const liveRows: Array<{ meta: StandaloneChatMeta; workEntryId: string }> = [];
  for (const entryId of entryIds) {
    const state = await host.readTabs(resolved, entryId);
    for (const tab of state?.tabs ?? []) {
      if ((tab.kind ?? 'chat') !== 'chat') continue;
      const lastMessage = tab.messages[tab.messages.length - 1];
      liveRows.push({
        workEntryId: entryId,
        meta: {
          id: tab.id,
          title: tab.title,
          description: chatTabStripLabel(tab),
          createdAt: tab.createdAt,
          messageCount: tab.messages.length,
          ...(lastMessage
            ? { lastMessageAt: new Date(lastMessage.timestamp).toISOString() }
            : {}),
          ...(tab.providerType ? { providerType: tab.providerType } : {}),
          ...(tab.pluginSelections
            ? { pluginSelections: tab.pluginSelections }
            : {}),
        },
      });
    }
  }
  const includeArchived = action.includeArchived === true;
  const archivedRows: Array<{
    meta: StandaloneChatMeta;
    workEntryId: string | null;
  }> = [];
  if (includeArchived) {
    for (const entryId of entryIds) {
      for (const archive of await host.listArchives(resolved, entryId)) {
        archivedRows.push({
          workEntryId: entryId,
          meta: {
            id: archive.chatId,
            title: archive.title,
            description: chatTabStripLabel(archive),
            createdAt: archive.createdAt,
            messageCount: archive.turnCount,
            providerType: archive.providerType,
            archived: true,
            archivedAt: archive.archivedAt,
          },
        });
      }
    }
    for (const chat of await host.listLegacyChats(resolved)) {
      if (chat.archived === true)
        archivedRows.push({ meta: chat, workEntryId: null });
    }
  }
  const rows = [...liveRows, ...archivedRows].filter(
    ({ meta }) =>
      !action.providerType || meta.providerType === action.providerType,
  );
  const max = clampLimit(
    action.limit,
    STANDALONE_LIST_DEFAULT_LIMIT,
    STANDALONE_LIST_MAX_LIMIT,
  );
  const matching = rows.filter(({ meta }) =>
    fuzzyMatchText(action.query, [
      meta.id,
      meta.title ?? '',
      meta.description ?? '',
      meta.providerType ?? '',
    ]),
  );
  const selected = matching.slice(0, max);
  return ok({
    projectId: resolved,
    query: action.query?.trim() ?? '',
    includeArchived,
    providerType: action.providerType ?? null,
    totalMatches: matching.length,
    returned: selected.length,
    chats: selected.map(({ meta, workEntryId }) =>
      standaloneChatSummary(
        meta,
        workEntryId,
        workEntryId ? memberships.get(workEntryId) : undefined,
      ),
    ),
  });
}

async function coworkPluginList(
  action: ActionOf<'standalone-chat.list_plugins'>,
  host: AdvisorChatReadHost,
): Promise<Outcome> {
  const resolved = await resolveCoworkProjectId(action.projectId, host);
  if (typeof resolved !== 'string') return failure(resolved.error);
  if (action.chatId) {
    const target = await resolveCoworkChat(resolved, action.chatId, host);
    if ('error' in target) return failure(target.error);
    return pluginList(
      action,
      target.tab.pluginSelections ?? emptyChatTabPluginSelections(),
      { projectId: resolved, chatId: action.chatId, title: target.tab.title },
      host,
    );
  }
  const project = await findCoworkProject(resolved, host);
  if ('error' in project) return failure(project.error);
  return pluginList(
    action,
    project.defaultPluginSelections ?? emptyChatTabPluginSelections(),
    {
      projectId: resolved,
      projectName: project.name,
      scope: 'standalone-project-defaults',
    },
    host,
  );
}

async function coworkSettings(
  action: ActionOf<'standalone-chat.get_settings'>,
  host: AdvisorChatReadHost,
): Promise<Outcome> {
  const project = await findCoworkProject(action.projectId, host);
  if ('error' in project) return failure(project.error);
  const [archiveIds, notes, prompts, attachments, claudeMd, entryIds] =
    await Promise.all([
      host.listProjectArchiveIds(action.projectId),
      host.listNotes(action.projectId),
      host.listPrompts(action.projectId),
      host.listAttachments(action.projectId),
      action.includeClaudeMd === true
        ? host.readCoworkClaudeMd(action.projectId)
        : Promise.resolve(undefined),
      host.listWorkEntryIds(action.projectId),
    ]);
  const entryArchives = await Promise.all(
    [...entryIds, COWORK_HOME_WORKTREE_ID].map((worktreeId) =>
      host.listArchives(action.projectId, worktreeId),
    ),
  );
  const archived = new Set(archiveIds);
  for (const archives of entryArchives)
    for (const archive of archives) archived.add(archive.chatId);
  return ok({
    project: jsonValue(project),
    summary: standaloneProjectSummary(project),
    counts: {
      archives: archived.size,
      notes: notes.length,
      prompts: prompts.length,
      attachments: attachments.length,
    },
    ...(claudeMd !== undefined ? { claudeMd } : {}),
  });
}

async function coworkItemRead(
  action: ActionOf<
    | 'standalone-chat.list_prompts'
    | 'standalone-chat.get_prompt'
    | 'standalone-chat.list_notes'
    | 'standalone-chat.get_note'
    | 'standalone-chat.list_attachments'
    | 'standalone-chat.get_attachment'
  >,
  host: AdvisorChatReadHost,
): Promise<Outcome> {
  switch (action.type) {
    case 'standalone-chat.list_prompts':
      return ok(
        standaloneWorkspaceListResult(
          await host.listPrompts(action.projectId),
          action.query,
          action.limit,
          (prompt) => [prompt.id, prompt.title],
        ),
      );
    case 'standalone-chat.get_prompt':
      return ok(
        jsonValue(await host.readPrompt(action.projectId, action.promptId)),
      );
    case 'standalone-chat.list_notes':
      return ok(
        standaloneWorkspaceListResult(
          await host.listNotes(action.projectId),
          action.query,
          action.limit,
          (note) => [note.id, note.title],
        ),
      );
    case 'standalone-chat.get_note':
      return ok(
        jsonValue(await host.readNote(action.projectId, action.noteId)),
      );
    case 'standalone-chat.list_attachments':
      return ok(
        standaloneWorkspaceListResult(
          await host.listAttachments(action.projectId),
          action.query,
          action.limit,
          (attachment) => [attachment.filename, attachment.absolutePath],
        ),
      );
    case 'standalone-chat.get_attachment': {
      const attachment = (await host.listAttachments(action.projectId)).find(
        (candidate) => candidate.filename === action.attachmentId,
      );
      if (!attachment)
        return failure({
          code: 'not_found',
          message: `Standalone attachment ${action.attachmentId} was not found in project ${action.projectId}.`,
        });
      // Only a listed attachment's own path is read, never one from the action.
      const content =
        action.includeContent === true
          ? await host.readFileContent(attachment.absolutePath)
          : undefined;
      return ok({
        meta: jsonValue(attachment),
        ...(content !== undefined ? { content: jsonValue(content) } : {}),
      });
    }
  }
}

const REQUIRED_FIELDS: Partial<Record<AdvisorChatReadType, readonly string[]>> =
  {
    'standalone-chat.get_settings': ['projectId'],
    'standalone-chat.read_history': ['projectId', 'chatId'],
    'standalone-chat.get_last_user_message': ['projectId', 'chatId'],
    'standalone-chat.get_last_agent_response': ['projectId', 'chatId'],
    'standalone-chat.list_prompts': ['projectId'],
    'standalone-chat.get_prompt': ['projectId', 'promptId'],
    'standalone-chat.list_notes': ['projectId'],
    'standalone-chat.get_note': ['projectId', 'noteId'],
    'standalone-chat.list_attachments': ['projectId'],
    'standalone-chat.get_attachment': ['projectId', 'attachmentId'],
  };

const ID_FIELDS = ['projectId', 'worktreeId', 'chatId'] as const;

/** The renderer's required-string check, then the ids main's owners join into paths. */
function invalidPayload(action: AdvisorChatReadAction): Outcome | null {
  const record: Record<string, unknown> = { ...action };
  const missing = (REQUIRED_FIELDS[action.type] ?? []).filter(
    (field) => typeof record[field] !== 'string' || record[field] === '',
  );
  if (missing.length > 0)
    return failure({
      code: 'invalid_payload',
      message: `Action ${action.type} requires ${missing.join(', ')}.`,
    });
  for (const field of ID_FIELDS) {
    // An empty optional id means omitted, as in the renderer.
    if (record[field] === undefined || record[field] === '') continue;
    try {
      validateId(record[field], field);
    } catch {
      return failure({
        code: 'invalid_payload',
        message: `Action ${action.type} has invalid ${field}.`,
      });
    }
  }
  return null;
}

async function run(
  action: AdvisorChatReadAction,
  host: AdvisorChatReadHost,
): Promise<Outcome> {
  switch (action.type) {
    case 'worktree-chat.list_tabs': {
      const scope = await resolveScope(action, host, false);
      if ('error' in scope) return failure(scope.error);
      return listTabs(scope, host);
    }
    case 'worktree-chat.read_history':
    case 'worktree-chat.get_last_user_message':
    case 'worktree-chat.get_last_agent_response': {
      const scope = await resolveScope(action, host, true);
      if ('error' in scope) return failure(scope.error);
      const target = await resolveChatTarget(scope, action.chatId, host);
      if ('error' in target) return failure(target.error);
      return historyResult(action, await withTranscript(target, host));
    }
    case 'worktree-chat.list_plugins':
      return worktreePluginList(action, host);
    case 'pipeline-assistant-chat.list_tabs':
    case 'pipeline-assistant-chat.read_history':
    case 'pipeline-assistant-chat.get_last_user_message':
    case 'pipeline-assistant-chat.get_last_agent_response':
    case 'pipeline-assistant-chat.list_plugins':
      return pipelineAssistantRead(action, host);
    case 'standalone-chat.list_projects':
      return listCoworkProjects(action, host);
    case 'standalone-chat.list_chats':
      return listCoworkChats(action, host);
    case 'standalone-chat.get_settings':
      return coworkSettings(action, host);
    case 'standalone-chat.list_plugins':
      return coworkPluginList(action, host);
    case 'standalone-chat.read_history':
    case 'standalone-chat.get_last_user_message':
    case 'standalone-chat.get_last_agent_response': {
      const target = await resolveCoworkChat(
        action.projectId,
        action.chatId,
        host,
      );
      if ('error' in target) return failure(target.error);
      return historyResult(action, target);
    }
    default:
      return coworkItemRead(action, host);
  }
}

/** One of {@link ADVISOR_CHAT_READ_ACTION_TYPES}, in main. Never throws. */
export async function dispatchAdvisorChatRead(
  action: AdvisorChatReadAction,
  host: AdvisorChatReadHost,
  requestId: string,
): Promise<AppAdvisorActionResponse> {
  let outcome: Outcome;
  try {
    outcome = invalidPayload(action) ?? (await run(action, host));
  } catch (error) {
    outcome = failure({
      code: 'execution_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return { ...outcome, requestId };
}
