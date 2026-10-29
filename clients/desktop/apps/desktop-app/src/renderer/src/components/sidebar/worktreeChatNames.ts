import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { deriveWorktreeChatName } from '@canopy/desktop-shared/lib/worktree-chat-name';
import type {
  PersistedChatTab,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';

/*
 * Early access names sidebar worktree rows after the chat that started them;
 * the second line stays the worktree's own name. Loaded worktrees read their live chat
 * tabs; the rest read the `chatBadges.chatName` main saves with every chat
 * write, so no transcript loads just to name a row.
 */

type ChatNameTab = Pick<
  PersistedChatTab,
  'kind' | 'title' | 'description' | 'customTitle' | 'createdAt'
>;

const EMPTY_NAMINGS: Readonly<Record<string, WorktreeRowNaming>> = {};
const EMPTY_LIVE_NAMES: Readonly<Record<string, string | null>> = {};

/**
 * Chat names for the loaded worktrees, keyed `projectId/worktreeId`. `null`
 * marks a loaded worktree whose chats are still unnamed, so a stale saved name
 * does not stand in for it.
 */
export function liveWorktreeChatNames(
  worktreeChats: Readonly<Record<string, { tabs: readonly ChatNameTab[] }>>,
): Record<string, string | null> {
  const names: Record<string, string | null> = {};
  for (const [key, chats] of Object.entries(worktreeChats)) {
    names[key] = deriveWorktreeChatName(chats.tabs) ?? null;
  }
  return names;
}

export interface WorktreeRowNaming {
  /** Replacement row title; `undefined` keeps the stored label or branch. */
  readonly title: string | undefined;
}

/** A label the user set keeps the title; otherwise the chat name takes it. */
export function deriveWorktreeRowNaming({
  storedLabel,
  chatName,
}: {
  storedLabel: string | undefined;
  chatName: string | undefined;
}): WorktreeRowNaming {
  if (storedLabel?.trim()) return { title: undefined };
  return { title: chatName };
}

/**
 * Naming for every stored worktree, keyed `projectId/worktreeId`: live chat
 * names first, then each worktree's saved chat name. Reads the label the user
 * set from the store, not the snapshot, whose `label` also carries generated
 * names.
 */
export function deriveWorktreeRowNamings(
  live: Readonly<Record<string, string | null>>,
  projects: readonly SidebarItem[],
): Record<string, WorktreeRowNaming> {
  const namings: Record<string, WorktreeRowNaming> = {};
  for (const project of projects) {
    if (project.type === 'cowork') continue;
    for (const worktree of project.worktrees) {
      const key = `${project.id}/${worktree.id}`;
      const chatName =
        (key in live ? live[key] : worktree.chatBadges?.chatName?.trim()) ||
        undefined;
      namings[key] = deriveWorktreeRowNaming({
        storedLabel: worktree.label,
        chatName,
      });
    }
  }
  return namings;
}

/** Every stored worktree's row naming while `enabled`; empty otherwise. */
export function useWorktreeRowNamings(
  enabled: boolean,
): Readonly<Record<string, WorktreeRowNaming>> {
  const live = useChatStore(
    useShallow((state) =>
      enabled ? liveWorktreeChatNames(state.worktreeChats) : EMPTY_LIVE_NAMES,
    ),
  );
  const projects = useProjectsStore((state) => state.projects);
  return useMemo(
    () => (enabled ? deriveWorktreeRowNamings(live, projects) : EMPTY_NAMINGS),
    [enabled, live, projects],
  );
}
