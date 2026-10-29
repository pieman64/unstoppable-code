import type { LedgerNavigator } from '@canopy/app-core';
import type { LedgerFileRef } from '@canopy/protocol/canopy-core';
import type {
  LedgerViewOpenResult,
  LedgerViewScope,
  LedgerViewSourceTarget,
} from '@canopy/protocol/ledger-view';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  openAutomationRunDestination,
  type AutomationRunDestination,
} from '@/components/automations/resolveAutomationRunDestination';
import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import { openSubagentChatPanel } from '@/lib/panels/subagent-panel-open';
import { useAgentFilePresentationStore } from '@/stores/agentFilePresentationStore';
import {
  useChatStore,
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
} from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';

/*
 * Opens Ledger sources and reference files in the desktop app. Chats and
 * pipeline runs reuse the navigation that automation run history uses, which
 * checks the target still exists before moving the person. A managed
 * delegate's source is its own subagent chat, beside the chat that started
 * it; once that chat is archived, the archived chat opens instead. Nothing
 * opened here starts, resumes or restores anything.
 */

const FILE_UNAVAILABLE = "Couldn't open this file. It may have moved.";
const FILE_OUTSIDE_PROJECT = "This file isn't in this project.";
const CHAT_UNAVAILABLE = 'That chat is no longer available.';

function failed(message: string): LedgerViewOpenResult {
  return { ok: false, message };
}

function isCoworkProject(projectId: string): boolean {
  return useProjectsStore
    .getState()
    .projects.some(
      (project) => project.id === projectId && project.type === 'cowork',
    );
}

/**
 * An archived worktree chat opens in the worktree tab bar's read-only
 * archive viewer, as Audit Trail opens one, never as a live tab.
 */
async function openArchivedWorktreeChat(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<LedgerViewOpenResult> {
  const chatStore = useChatStore.getState();
  useNavigationStore.getState().navigate('main');
  chatStore.selectWorktree(projectId, worktreeId);
  try {
    await chatStore.loadTabsForTarget(projectId, worktreeId);
  } catch {
    return failed(CHAT_UNAVAILABLE);
  }
  // A frame's delay lets the selected worktree's tab bar mount its listener.
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent(WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT, {
        detail: { projectId, worktreeId, chatId },
      }),
    );
  });
  return { ok: true };
}

function chatDestination(
  target: Extract<LedgerViewSourceTarget, { kind: 'chat' }>,
): AutomationRunDestination {
  if (target.projectId === APP_ADVISOR_PROJECT_ID) {
    return {
      kind: 'app-advisor-chat',
      chatId: target.chatId,
      ...(target.delegationId !== undefined && !target.archived
        ? { delegationId: target.delegationId }
        : {}),
    };
  }
  if (isCoworkProject(target.projectId)) {
    return {
      kind: 'cowork-chat',
      workspaceId: target.projectId,
      chatId: target.chatId,
    };
  }
  return {
    kind: 'worktree-chat',
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
  };
}

async function openSource(
  _scope: LedgerViewScope,
  target: LedgerViewSourceTarget,
): Promise<LedgerViewOpenResult> {
  if (target.kind === 'summary') {
    // The recorded snapshot shows in the entry itself.
    return { ok: true };
  }
  let destination: AutomationRunDestination;
  if (target.kind === 'pipeline') {
    // At the exact job the agent ran in; the run's page selects a job, not
    // a step or attempt.
    destination = {
      kind: 'pipeline-execution',
      executionId: target.executionId,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      ...(target.jobId === undefined ? {} : { jobId: target.jobId }),
    };
  } else {
    destination = chatDestination(target);
    if (target.archived && destination.kind === 'worktree-chat') {
      return openArchivedWorktreeChat(
        destination.projectId,
        destination.worktreeId,
        destination.chatId,
      );
    }
  }
  const result = await openAutomationRunDestination(destination);
  if (!result.ok) return failed(result.error);
  // App Advisor owns its own panel store; its window command reveals the source.
  if (destination.kind === 'app-advisor-chat') return { ok: true };
  if (target.kind === 'chat') {
    if (target.delegationId !== undefined && !target.archived) {
      // The panel takes the delegate's title once its chat's tree loads.
      const opened = await openSubagentChatPanel(
        { projectId: target.projectId, worktreeId: target.worktreeId },
        {
          rootChatId: target.chatId,
          subagentId: target.delegationId,
          subagentKind: 'managed',
          title: '',
        },
      );
      if (opened.status === 'revealed' || opened.status === 'placed') {
        return { ok: true };
      }
      // No group took the panel: the chat that started the delegate shows.
    }
    // Selecting the chat that is already active changes nothing, so the
    // grid is asked to show its panel, which may sit behind the Ledger tab.
    requestChatPanelReveal(target.projectId, target.worktreeId, target.chatId);
  }
  return { ok: true };
}

/** Joins a portable relative path onto a root, refusing to leave it. */
function joinWithinRoot(root: string, relativePath: string): string | null {
  const segments: string[] = [];
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  const windowsRoot = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(root);
  const separator = windowsRoot ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${segments.join(separator)}`;
}

async function openFile(
  scope: LedgerViewScope,
  file: LedgerFileRef,
): Promise<LedgerViewOpenResult> {
  const target = { projectId: scope.projectId, worktreeId: scope.worktreeId };
  let absolutePath: string | null;
  try {
    const { roots } = await window.api.getFileTreeRoots(target);
    const root = roots.find((candidate) => candidate.repoId === file.rootId);
    if (root === undefined) return failed(FILE_OUTSIDE_PROJECT);
    absolutePath = joinWithinRoot(root.absolutePath, file.path);
  } catch {
    return failed(FILE_UNAVAILABLE);
  }
  if (absolutePath === null) return failed(FILE_OUTSIDE_PROJECT);
  let filename: string;
  try {
    // Main resolves the path and the project's roots through realpath and
    // refuses anything outside them, so a link cannot escape the project.
    const content = await window.api.readFileContent({
      absolutePath,
      workspaceTarget: target,
    });
    if (content.kind === 'missing' || content.kind === 'unsupported') {
      return failed(FILE_UNAVAILABLE);
    }
    filename = content.filename;
  } catch {
    return failed(FILE_UNAVAILABLE);
  }
  const chatStore = useChatStore.getState();
  if (!isCoworkProject(scope.projectId)) {
    // The file opens in its worktree's tabs; leave the Feed for that
    // worktree first, or the tab would open out of sight.
    useNavigationStore.getState().navigate('main');
    chatStore.selectWorktree(scope.projectId, scope.worktreeId);
    try {
      await chatStore.loadTabsForTarget(scope.projectId, scope.worktreeId);
    } catch {
      return failed(FILE_UNAVAILABLE);
    }
  }
  const tabId = chatStore.openFileTab({ absolutePath, filename }, target);
  if (tabId === null) return failed(FILE_UNAVAILABLE);
  if (file.startLine !== undefined) {
    useAgentFilePresentationStore
      .getState()
      .present(tabId, { line: file.startLine });
  }
  chatStore.switchTab(tabId, target);
  return { ok: true };
}

export const DESKTOP_LEDGER_NAVIGATOR: LedgerNavigator = {
  openSource,
  openFile,
};
