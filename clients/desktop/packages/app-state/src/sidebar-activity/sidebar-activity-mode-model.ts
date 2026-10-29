import type { SessionViewModel } from '@canopy/app-core';
import { chatTabLabel } from '@canopy/protocol';

/**
 * Pure model behind the sidebar Activity mode (CAN-390).
 *
 * Activity flattens a complete chat inventory into three ordered sections —
 * Unread, Drafts, Unreplied — that the shared sidebar renders in place of the
 * workspace tree. The result is built once per toggle cycle and frozen: live
 * unread dots and selection update in place, but membership, order, titles,
 * and context do not change until the user toggles Activity off and on.
 */

/** Unreplied rows shown initially, and appended by each Show more. */
export const SIDEBAR_ACTIVITY_UNREPLIED_PAGE_SIZE = 50;

export type SidebarActivitySection = 'unread' | 'drafts' | 'unreplied';

type ShellWorkspace = SessionViewModel['workspaces'][number];

/**
 * The fields Activity reads, structurally, so the desktop snapshot and the
 * Portal's browser projection (looser optional fields) both fit.
 */
export interface SidebarActivityWorkspace {
  readonly localId: string;
  readonly name: string;
  readonly type?: ShellWorkspace['type'];
  readonly hidden?: boolean;
  readonly placeholder?: unknown;
  readonly repos?: readonly { readonly id: string; readonly name: string }[];
}

export interface SidebarActivityWorktree {
  readonly localId: string;
  readonly workspaceLocalId: string;
  readonly branch: string;
  readonly label?: string;
  readonly hidden?: boolean;
}

interface SidebarActivityChatFields {
  readonly title: string;
  readonly customTitle?: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly lastMessageAt?: string;
  readonly lastMessageRole?: 'user' | 'assistant';
}

export interface SidebarActivityStandaloneChat extends SidebarActivityChatFields {
  readonly localId: string;
  readonly projectLocalId?: string;
  readonly archived?: boolean;
  readonly hasUnread?: boolean;
  readonly hasActiveChat?: boolean;
}

export interface SidebarActivityChatSummary extends SidebarActivityChatFields {
  readonly hasUnread?: boolean;
  readonly archived?: boolean;
  readonly chatId: string;
  readonly scope: string;
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly selectedRepoId?: string;
  readonly turnActive?: boolean;
}

/** The shell collections Activity classifies. */
export interface SidebarActivityInventory {
  readonly workspaces: readonly SidebarActivityWorkspace[];
  readonly worktrees: readonly SidebarActivityWorktree[];
  readonly standaloneChats: readonly SidebarActivityStandaloneChat[];
  readonly chatSummaries: readonly SidebarActivityChatSummary[];
}

/** Everything one build reads. Hosts prepare it after a complete load. */
export interface SidebarActivityBuildInput {
  readonly inventory: SidebarActivityInventory;
  /** Chat keys the host reports unread at load time. */
  readonly unreadKeys?: ReadonlySet<string>;
  /** Chat keys with an unsent draft. Only hosts with `chatDrafts` supply it. */
  readonly draftKeys?: ReadonlySet<string>;
  /** Worktree row label; defaults to the branch. */
  readonly worktreeLabel?: (
    workspace: SidebarActivityWorkspace,
    worktree: SidebarActivityWorktree,
  ) => string;
}

interface SidebarActivityEntryBase {
  /** Scope-qualified identity: row key, selection, unread membership. */
  readonly key: string;
  /** The chat id navigation needs, kept apart from {@link key}. */
  readonly chatId: string;
  readonly section: SidebarActivitySection;
  readonly title: string;
  readonly workspaceName: string;
  /** Epoch ms of `lastMessageAt ?? createdAt`; `null` when neither parses. */
  readonly recencyAt: number | null;
}

export interface SidebarActivityWorktreeEntry extends SidebarActivityEntryBase {
  readonly kind: 'worktree-chat';
  readonly workspaceLocalId: string;
  readonly worktreeLocalId: string;
  readonly branchLabel: string;
  /** Selected repository name, else the workspace name. */
  readonly repositoryName: string;
}

export interface SidebarActivityStandaloneEntry extends SidebarActivityEntryBase {
  readonly kind: 'standalone-chat';
  readonly projectLocalId: string;
}

export type SidebarActivityEntry =
  | SidebarActivityWorktreeEntry
  | SidebarActivityStandaloneEntry;

/** One frozen build. Arrays are frozen and never mutated after the build. */
export interface SidebarActivitySnapshot {
  readonly unread: readonly SidebarActivityEntry[];
  readonly drafts: readonly SidebarActivityEntry[];
  readonly unreplied: readonly SidebarActivityEntry[];
}

/**
 * Activity key for a worktree chat. JSON keeps the parts apart whatever
 * characters the ids carry, so no two scopes collide on a delimiter.
 */
export function sidebarActivityWorktreeChatKey(
  workspaceLocalId: string,
  worktreeLocalId: string,
  chatId: string,
): string {
  return JSON.stringify([
    'worktree',
    workspaceLocalId,
    worktreeLocalId,
    chatId,
  ]);
}

/** Activity key for a Cowork (standalone) chat. */
export function sidebarActivityStandaloneChatKey(
  projectLocalId: string,
  chatId: string,
): string {
  return JSON.stringify(['standalone', projectLocalId, chatId]);
}

const SECTION_RANK: Record<SidebarActivitySection, number> = {
  unread: 0,
  drafts: 1,
  unreplied: 2,
};

function isId(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function parseTime(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recencyOf(
  lastMessageAt: string | undefined,
  createdAt: string | undefined,
): number | null {
  return parseTime(lastMessageAt) ?? parseTime(createdAt);
}

function classify(
  key: string,
  unread: boolean,
  input: SidebarActivityBuildInput,
  unreplied: boolean,
): SidebarActivitySection | null {
  if (input.unreadKeys === undefined ? unread : input.unreadKeys.has(key))
    return 'unread';
  if (input.draftKeys?.has(key) === true) return 'drafts';
  return unreplied ? 'unreplied' : null;
}

/** Newest first; missing times last; ties by key so the order is total. */
export function compareSidebarActivityEntries(
  first: SidebarActivityEntry,
  second: SidebarActivityEntry,
): number {
  if (first.recencyAt !== second.recencyAt) {
    if (first.recencyAt === null) return 1;
    if (second.recencyAt === null) return -1;
    return second.recencyAt - first.recencyAt;
  }
  return first.key < second.key ? -1 : first.key > second.key ? 1 : 0;
}

/**
 * Two projections of one chat collapse into one row: the higher-priority
 * section wins, and the newer projection supplies the captured fields.
 */
function mergeDuplicate(
  kept: SidebarActivityEntry,
  next: SidebarActivityEntry,
): SidebarActivityEntry {
  const newer =
    (next.recencyAt ?? Number.NEGATIVE_INFINITY) >
    (kept.recencyAt ?? Number.NEGATIVE_INFINITY)
      ? next
      : kept;
  const section =
    SECTION_RANK[next.section] < SECTION_RANK[kept.section]
      ? next.section
      : kept.section;
  return newer.section === section ? newer : { ...newer, section };
}

function worktreeEntries(
  input: SidebarActivityBuildInput,
  visibleWorkspaces: ReadonlyMap<string, SidebarActivityWorkspace>,
): SidebarActivityEntry[] {
  const { inventory } = input;
  const worktrees = new Map<string, SidebarActivityWorktree>();
  for (const worktree of inventory.worktrees) {
    if (worktree.hidden === true) continue;
    worktrees.set(
      JSON.stringify([worktree.workspaceLocalId, worktree.localId]),
      worktree,
    );
  }
  const entries: SidebarActivityEntry[] = [];
  for (const summary of inventory.chatSummaries) {
    if (summary.scope !== 'worktree' || summary.archived === true) continue;
    const { workspaceLocalId, worktreeLocalId, chatId } = summary;
    if (!isId(workspaceLocalId) || !isId(worktreeLocalId) || !isId(chatId))
      continue;
    const workspace = visibleWorkspaces.get(workspaceLocalId);
    if (
      workspace === undefined ||
      (workspace.type !== 'single-repo' && workspace.type !== 'multi-repo')
    )
      continue;
    const worktree = worktrees.get(
      JSON.stringify([workspaceLocalId, worktreeLocalId]),
    );
    if (worktree === undefined) continue;
    const key = sidebarActivityWorktreeChatKey(
      workspaceLocalId,
      worktreeLocalId,
      chatId,
    );
    const section = classify(
      key,
      summary.hasUnread === true,
      input,
      summary.lastMessageRole === 'assistant' && summary.turnActive !== true,
    );
    if (section === null) continue;
    // The shell carries a selected repo only on multi-repo summaries; every
    // other row names its workspace, which is also the repo's display name.
    const repositoryName =
      workspace.repos?.find((repo) => repo.id === summary.selectedRepoId)
        ?.name ?? workspace.name;
    entries.push({
      kind: 'worktree-chat',
      key,
      chatId,
      section,
      title: chatTabLabel(summary),
      workspaceName: workspace.name,
      recencyAt: recencyOf(summary.lastMessageAt, summary.createdAt),
      workspaceLocalId,
      worktreeLocalId,
      branchLabel:
        input.worktreeLabel?.(workspace, worktree) ?? worktree.branch,
      repositoryName,
    });
  }
  return entries;
}

function standaloneEntries(
  input: SidebarActivityBuildInput,
  visibleWorkspaces: ReadonlyMap<string, SidebarActivityWorkspace>,
): SidebarActivityEntry[] {
  const entries: SidebarActivityEntry[] = [];
  for (const chat of input.inventory.standaloneChats) {
    if (chat.archived === true) continue;
    if (!isId(chat.localId) || !isId(chat.projectLocalId)) continue;
    const workspace = visibleWorkspaces.get(chat.projectLocalId);
    if (workspace?.type !== 'cowork') continue;
    const key = sidebarActivityStandaloneChatKey(
      chat.projectLocalId,
      chat.localId,
    );
    const section = classify(
      key,
      chat.hasUnread === true,
      input,
      chat.lastMessageRole === 'assistant' && chat.hasActiveChat !== true,
    );
    if (section === null) continue;
    entries.push({
      kind: 'standalone-chat',
      key,
      chatId: chat.localId,
      section,
      title: chatTabLabel(chat),
      workspaceName: workspace.name,
      recencyAt: recencyOf(chat.lastMessageAt, chat.createdAt),
      projectLocalId: chat.projectLocalId,
    });
  }
  return entries;
}

/**
 * Classify a complete inventory into the frozen Activity sections.
 *
 * A chat qualifies under exactly one section, by precedence Unread > Drafts >
 * Unreplied. Unreplied means the newest user/assistant message is the
 * assistant's and no turn is running; an unknown role never qualifies.
 * Archived chats, hidden or missing parents, invalid ids, and scopes other
 * than worktree and Cowork chats are excluded. Inputs are never mutated.
 */
export function buildSidebarActivitySnapshot(
  input: SidebarActivityBuildInput,
): SidebarActivitySnapshot {
  const visibleWorkspaces = new Map<string, SidebarActivityWorkspace>();
  for (const workspace of input.inventory.workspaces) {
    if (workspace.hidden === true || workspace.placeholder !== undefined)
      continue;
    if (!isId(workspace.localId)) continue;
    visibleWorkspaces.set(workspace.localId, workspace);
  }
  const byKey = new Map<string, SidebarActivityEntry>();
  for (const entry of [
    ...worktreeEntries(input, visibleWorkspaces),
    ...standaloneEntries(input, visibleWorkspaces),
  ]) {
    const kept = byKey.get(entry.key);
    byKey.set(entry.key, kept ? mergeDuplicate(kept, entry) : entry);
  }
  const sections: Record<SidebarActivitySection, SidebarActivityEntry[]> = {
    unread: [],
    drafts: [],
    unreplied: [],
  };
  byKey.forEach((entry) => {
    sections[entry.section].push(Object.freeze(entry));
  });
  return Object.freeze({
    unread: Object.freeze(sections.unread.sort(compareSidebarActivityEntries)),
    drafts: Object.freeze(sections.drafts.sort(compareSidebarActivityEntries)),
    unreplied: Object.freeze(
      sections.unreplied.sort(compareSidebarActivityEntries),
    ),
  });
}
