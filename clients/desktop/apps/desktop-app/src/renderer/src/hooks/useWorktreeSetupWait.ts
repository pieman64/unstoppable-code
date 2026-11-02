import { useEffect, useMemo, useRef, useState } from 'react';
import {
  queuedMessageSendingAnnouncement,
  queuedMessageSetupAnnouncement,
  type QueuedMessageAnnouncement,
  type QueuedMessageSetupWait,
} from '@canopy/ui-shared/components';
import { readWorktreeSetupDuration } from '@/lib/worktreeSetupDurations';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { subscribeSetupQueueDispatch } from '@/stores/chat/setup-queue-dispatch';
import type { QueuedChatMessage } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';

export interface WorktreeSetupWaitTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/** The worktree row's setup origin, when it can anchor an estimate. */
function useSetupRowOrigin(
  target: WorktreeSetupWaitTarget | null,
): number | null {
  return useProjectsStore((state): number | null => {
    if (!target) return null;
    const project = state.projects.find(
      (candidate) => candidate.id === target.projectId,
    );
    if (!project || project.type === 'cowork') return null;
    const row = project.worktrees.find(
      (worktree) => worktree.id === target.worktreeId,
    );
    if (row?.setupPhase !== 'git-pending') return null;
    const createdAtMs = Date.parse(row.createdAt);
    return Number.isFinite(createdAtMs) ? createdAtMs : null;
  });
}

function useProjectName(projectId: string | undefined): string | undefined {
  return useProjectsStore((state): string | undefined => {
    if (projectId === undefined) return undefined;
    const project = state.projects.find(
      (candidate) => candidate.id === projectId,
    );
    if (!project || !project.name?.trim()) return undefined;
    return getWorkspaceDisplayName(project);
  });
}

function earliestEnqueuedAt(
  messages: readonly QueuedChatMessage[],
  nowMs: number,
): number | null {
  let earliest: number | null = null;
  for (const message of messages) {
    const at = message.enqueuedAtMs;
    if (at === undefined || !Number.isFinite(at) || at < 0 || at > nowMs)
      continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

interface FrozenWait {
  readonly key: string;
  readonly startedAtMs: number;
  readonly estimateMs?: number;
}

/**
 * Start a wait's clock: from the worktree row's `createdAt` when the row is
 * still setting up (the origin setup history measures, so its estimate
 * applies), else from the earliest queued message, else from now. Only the
 * row origin gets an estimate; subtracting a message's wait from a
 * worktree's setup time would mislead.
 */
function startWait(
  key: string,
  projectId: string,
  rowOrigin: number | null,
  messages: readonly QueuedChatMessage[],
  nowMs: number,
): FrozenWait {
  if (rowOrigin !== null && rowOrigin >= 0 && rowOrigin <= nowMs) {
    const estimateMs = readWorktreeSetupDuration(projectId);
    return {
      key,
      startedAtMs: rowOrigin,
      ...(estimateMs !== null ? { estimateMs } : {}),
    };
  }
  return {
    key,
    startedAtMs: earliestEnqueuedAt(messages, nowMs) ?? nowMs,
  };
}

/**
 * The setup wait a chat's queued messages are held behind, for the shared
 * queued reason, or `undefined` when they aren't waiting for setup.
 *
 * A wait starts when the chat's queue becomes setup-queued and ends when it
 * isn't; a later wait on the same chat starts fresh. Its start and estimate
 * are frozen when it starts, so a late worktree row, a deleted message, or
 * new history can't reset the visible clock.
 */
export function useWorktreeSetupWait(
  target: WorktreeSetupWaitTarget | null,
  queuedForSetup: boolean,
  queuedMessages: readonly QueuedChatMessage[],
): QueuedMessageSetupWait | undefined {
  const rowOrigin = useSetupRowOrigin(target);
  const projectName = useProjectName(target?.projectId);
  const [frozen, setFrozen] = useState<FrozenWait | null>(null);
  const key =
    target && queuedForSetup
      ? `${target.projectId}/${target.worktreeId}/${target.chatId}`
      : null;
  let current = frozen;
  if (key === null) {
    current = null;
    if (frozen !== null) setFrozen(null);
  } else if (frozen?.key !== key && target) {
    current = startWait(
      key,
      target.projectId,
      rowOrigin,
      queuedMessages,
      Date.now(),
    );
    setFrozen(current);
  }
  return useMemo(
    () =>
      current
        ? {
            startedAtMs: current.startedAtMs,
            ...(current.estimateMs !== undefined
              ? { estimateMs: current.estimateMs }
              : {}),
            ...(projectName !== undefined ? { projectName } : {}),
          }
        : undefined,
    [current, projectName],
  );
}

/**
 * What the chat's queue announcer says: the queued reason once when a setup
 * wait starts with messages held, and "Sending your message." when the setup
 * queue actually hands this chat's messages to the agent. Ticks, rerenders,
 * deletion, failure, hydration and other chats announce nothing; switching
 * chats clears what is pending.
 */
export function useSetupQueueAnnouncement(
  target: WorktreeSetupWaitTarget | null,
  setupWait: QueuedMessageSetupWait | undefined,
  hasQueuedMessages: boolean,
): QueuedMessageAnnouncement | null {
  const [announcement, setAnnouncement] =
    useState<QueuedMessageAnnouncement | null>(null);
  const nextId = useRef(0);
  const announcedWait = useRef<string | null>(null);
  const observedSetupInput = useRef(false);
  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const chatId = target?.chatId;

  useEffect(() => {
    setAnnouncement(null);
    announcedWait.current = null;
    observedSetupInput.current = false;
    if (
      projectId === undefined ||
      worktreeId === undefined ||
      chatId === undefined
    ) {
      return undefined;
    }
    let dispatchBatchCount = 0;
    return subscribeSetupQueueDispatch(
      (dispatch) => {
        if (
          dispatch.projectId !== projectId ||
          dispatch.worktreeId !== worktreeId ||
          dispatch.chatId !== chatId ||
          dispatch.count < 1 ||
          !observedSetupInput.current
        ) {
          return;
        }
        dispatchBatchCount += dispatch.count;
        // Handoffs observed in the same microtask batch share one polite
        // announcement. The announcer's delayed update speaks the final count.
        queueMicrotask(() => {
          dispatchBatchCount = 0;
        });
        nextId.current += 1;
        setAnnouncement({
          id: nextId.current,
          text: queuedMessageSendingAnnouncement(dispatchBatchCount),
        });
      },
      { projectId, worktreeId, chatId },
    );
  }, [projectId, worktreeId, chatId]);

  const waitKey =
    setupWait && hasQueuedMessages ? `${setupWait.startedAtMs}` : null;
  const name = setupWait?.projectName;
  useEffect(() => {
    if (waitKey === null) {
      announcedWait.current = null;
      setAnnouncement((current) =>
        current?.text.startsWith('Queued.') ? null : current,
      );
      return;
    }
    observedSetupInput.current = true;
    if (announcedWait.current === waitKey) return;
    announcedWait.current = waitKey;
    nextId.current += 1;
    setAnnouncement({
      id: nextId.current,
      text: queuedMessageSetupAnnouncement(name),
    });
    // A name arriving later fills nothing in: the wait was already announced.
  }, [projectId, worktreeId, chatId, waitKey, name]);

  return announcement;
}
