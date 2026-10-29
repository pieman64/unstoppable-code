import { useEffect, useState } from 'react';
import {
  APP_ADVISOR_PROJECT_ID,
  getExecutionHarnessForModel,
} from '@canopy/desktop-shared/types';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  getAutomationChatRunMode,
  getAutomationExistingChatTarget,
} from '@canopy/desktop-shared/lib/automations';
import { useProjectsStore } from '@/stores/projectsStore';

/** Whether an automation's "Existing chat" destination can take its next run. */
export interface AutomationChatTargetAvailability {
  /** Run now must wait: the destination is unavailable or still checking. */
  blocked: boolean;
}

/**
 * Checks an automation's "Existing chat" destination. Future-run
 * availability is stricter than run-history navigation: a read-only archived
 * chat may still be openable as history, but it cannot receive the next
 * automation message.
 */
export function useAutomationChatTargetAvailability(
  activity: ScheduledActivity | null,
): AutomationChatTargetAvailability {
  const projects = useProjectsStore((state) => state.projects);
  // "Existing chat" (CAN-2937) covers both continuing a chat and
  // opening a new chat each run in an existing worktree / Work Entry.
  // A new draft has no destination to check yet.
  const chatRunMode = activity
    ? getAutomationChatRunMode(activity.action)
    : undefined;
  const existingTarget =
    activity && chatRunMode === 'existing_chat'
      ? getAutomationExistingChatTarget(activity.action)
      : undefined;
  const hasExistingTarget = existingTarget !== undefined;
  const sessionWorkspaceId = existingTarget?.workspaceId ?? '';
  const sessionWorktreeId = existingTarget?.worktreeId ?? '';
  const sessionChatId = existingTarget?.chatId ?? '';
  const sessionIsAppAdvisor = sessionWorkspaceId === APP_ADVISOR_PROJECT_ID;
  const sessionIsCowork = projects.some(
    (project) => project.id === sessionWorkspaceId && project.type === 'cowork',
  );
  const chatTargetKey = JSON.stringify([
    sessionWorkspaceId,
    sessionWorktreeId,
    sessionChatId,
  ]);
  const [chatTargetValidation, setChatTargetValidation] = useState<{
    key: string;
    availability: 'pending' | 'available' | 'unavailable';
  }>({ key: '', availability: 'pending' });
  const chatTargetAvailability =
    chatTargetValidation.key === chatTargetKey
      ? chatTargetValidation.availability
      : 'pending';
  const chatTargetBlocked =
    chatRunMode === 'existing_chat' && chatTargetAvailability !== 'available';

  // Future-run availability is stricter than run-history navigation: a
  // read-only archived chat may still be openable as history, but it cannot
  // receive the next automation message. Verify the workspace container and
  // then, for a specific chat, require a live, writable tab, matching the form
  // picker. A new chat each run needs only the container.
  useEffect(() => {
    if (!hasExistingTarget) {
      setChatTargetValidation({
        key: chatTargetKey,
        availability: 'available',
      });
      return undefined;
    }
    let cancelled = false;
    const settle = (availability: 'available' | 'unavailable'): void => {
      if (cancelled) return;
      setChatTargetValidation({ key: chatTargetKey, availability });
    };
    setChatTargetValidation({
      key: chatTargetKey,
      availability: 'pending',
    });
    void (async (): Promise<void> => {
      try {
        const project = projects.find(
          (candidate) => candidate.id === sessionWorkspaceId,
        );
        if (sessionIsAppAdvisor || sessionIsCowork) {
          const listed = await window.api.workEntries.list({
            projectId: sessionWorkspaceId,
          });
          const entry = listed.entries.find(
            (candidate) => candidate.id === sessionWorktreeId,
          );
          if (!entry) {
            settle('unavailable');
            return;
          }
        } else if (
          !project ||
          project.type === 'cowork' ||
          !project.worktrees.some(
            (worktree) => worktree.id === sessionWorktreeId,
          )
        ) {
          settle('unavailable');
          return;
        }
        if (!sessionChatId) {
          settle('available');
          return;
        }
        const tabs = await window.api.chat.loadTabs({
          projectId: sessionWorkspaceId,
          worktreeId: sessionWorktreeId,
        });
        const available = tabs.tabs.some(
          (tab) =>
            tab.id === sessionChatId &&
            (tab.kind ?? 'chat') === 'chat' &&
            tab.readOnly !== true &&
            tab.providerType !== 'cursor' &&
            tab.executionHarness !== 'cursor' &&
            (!tab.model || getExecutionHarnessForModel(tab.model) !== 'cursor'),
        );
        settle(available ? 'available' : 'unavailable');
      } catch {
        settle('unavailable');
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [
    chatTargetKey,
    hasExistingTarget,
    sessionChatId,
    sessionIsAppAdvisor,
    sessionIsCowork,
    sessionWorkspaceId,
    sessionWorktreeId,
    projects,
  ]);

  return {
    blocked: chatTargetBlocked,
  };
}
