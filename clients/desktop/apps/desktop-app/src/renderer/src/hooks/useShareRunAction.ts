import { useCallback, useRef, useState } from 'react';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import type {
  ShareRunShareRequest,
  ShareRunSuccess,
} from '@/components/shared/ShareRunModal';
import { isCoworkChatTarget } from '@/lib/cowork';
import {
  type ShareRunEligibilityResponse,
  type ShareRunResponse,
  type SharedRunMetadata,
} from '@canopy/desktop-shared/types';
import { ShareCompletionRolledBackError } from '@canopy/ui-app/sharing';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { teamOrgShareEntryVisible } from '@/lib/share-targets';

export interface ShareRunActionTarget {
  chatId: string;
  title: string;
  ownerDocument?: Document;
  existingShare?: SharedRunMetadata;
}

export interface ShareRunActionController {
  /** Whether a new or existing run share entry belongs in this context. */
  entryVisible: (existingShare?: SharedRunMetadata) => boolean;
  /** The chat session currently targeted for sharing, or null when idle. */
  target: ShareRunActionTarget | null;
  /** Open the share modal for a finished run (chat session). */
  open: (
    chatId: string,
    title: string,
    ownerDocument?: Document,
    existingShare?: SharedRunMetadata,
  ) => void;
  /** Dismiss the share modal without sharing. */
  close: () => void;
  /** Modal `onShare`: performs the share; the dialog reports failures inline. */
  submit: (request: ShareRunShareRequest) => Promise<ShareRunResponse>;
  /**
   * Modal `checkEligibility`: whether the target session still has shareable
   * activity, so an aged-out session is explained before an audience is picked.
   */
  checkEligibility: () => Promise<ShareRunEligibilityResponse>;
  /**
   * Modal `onShared`: persists the local "Shared" indicator (chat tab + cowork
   * meta) before the dialog closes and reports success.
   */
  onShared: (result: ShareRunSuccess) => Promise<void>;
}

/**
 * Shared "Share session" controller. Centralizes target state, redacted
 * shared-run publishing and completion semantics so every host
 * that surfaces the action (worktree panel tab menu, cowork chat header, the
 * legacy `ChatTabBar`) behaves identically. `projectId`/`worktreeId` are passed
 * as primitives so the returned callbacks stay referentially stable.
 */
export function useShareRunAction(
  projectId: string | null,
  worktreeId: string | null,
): ShareRunActionController {
  const shareRun = useActivityStore((s) => s.shareRun);
  const unshareRun = useActivityStore((s) => s.unshareRun);
  const context = useSidebarScopingContext();
  const [target, setTarget] = useState<ShareRunActionTarget | null>(null);
  const pendingCanonicalCleanupRef = useRef<{
    projectId: string;
    worktreeId: string;
    chatId: string;
  } | null>(null);

  const entryVisible = useCallback(
    (existingShare?: SharedRunMetadata): boolean =>
      teamOrgShareEntryVisible(
        context,
        existingShare !== undefined && existingShare.shareScope !== 'private',
      ),
    [context],
  );

  const open = useCallback(
    (
      chatId: string,
      title: string,
      ownerDocument?: Document,
      existingShare?: SharedRunMetadata,
    ): void => {
      if (pendingCanonicalCleanupRef.current !== null) return;
      // Prefer the worktree summary title (the concise, by-design-short title
      // shown in the Activity "Summary" card) over the raw first-message tab
      // title, falling back to the passed title until a summary exists.
      const summaryTitle =
        projectId !== null && worktreeId !== null
          ? useActivityStore.getState().worktreeSummaries[
              `${projectId}/${worktreeId}`
            ]?.title
          : undefined;
      const resolvedTitle =
        summaryTitle && summaryTitle.trim().length > 0 ? summaryTitle : title;
      setTarget({
        chatId,
        title: resolvedTitle,
        ...(ownerDocument ? { ownerDocument } : {}),
        ...(existingShare ? { existingShare } : {}),
      });
    },
    [projectId, worktreeId],
  );

  const close = useCallback((): void => {
    if (pendingCanonicalCleanupRef.current !== null) return;
    setTarget(null);
  }, []);

  const submit = useCallback(
    async (request: ShareRunShareRequest): Promise<ShareRunResponse> => {
      if (projectId === null || worktreeId === null || target === null) {
        return { externalId: null };
      }
      return shareRun(projectId, worktreeId, target.chatId, {
        shareScope: request.shareScope,
        ...(request.teamId ? { teamId: request.teamId } : {}),
        ...(request.organizationId
          ? { organizationId: request.organizationId }
          : {}),
      });
    },
    [projectId, worktreeId, shareRun, target],
  );

  const checkShareEligibility = useActivityStore(
    (s) => s.checkShareEligibility,
  );
  const checkEligibility =
    useCallback(async (): Promise<ShareRunEligibilityResponse> => {
      if (projectId === null || worktreeId === null || target === null) {
        // Nothing to probe; let the picker render and the share report the truth.
        return { shareable: true, auditRetentionDays: 0 };
      }
      return checkShareEligibility(projectId, worktreeId, target.chatId);
    }, [checkShareEligibility, projectId, worktreeId, target]);

  const onShared = useCallback(
    async (result: ShareRunSuccess): Promise<void> => {
      if (projectId !== null && worktreeId !== null && target !== null) {
        const pendingCleanup = pendingCanonicalCleanupRef.current;
        if (
          pendingCleanup?.projectId === projectId &&
          pendingCleanup.worktreeId === worktreeId &&
          pendingCleanup.chatId === target.chatId
        ) {
          try {
            await useChatStore
              .getState()
              .setSharedRun(projectId, worktreeId, target.chatId, undefined);
          } catch {
            throw new Error(
              'Session share was revoked, but its local status could not be cleared. Retry to finish cleaning up.',
            );
          }
          pendingCanonicalCleanupRef.current = null;
          throw new ShareCompletionRolledBackError(
            'Session share state could not be saved. The share was revoked; retry sharing.',
          );
        }
        const sharedRun: SharedRunMetadata = {
          externalId: result.externalId,
          ...(result.teamId ? { teamId: result.teamId } : {}),
          ...(result.teamName ? { teamName: result.teamName } : {}),
          ...(result.organizationId
            ? { organizationId: result.organizationId }
            : {}),
          ...(result.organizationName
            ? { organizationName: result.organizationName }
            : {}),
          shareScope: result.shareScope,
          sharedAt: new Date().toISOString(),
        };
        // Mirror the local "Shared" indicator onto the chat tab (source of
        // truth) and, for cowork sessions, re-derive the work-entry meta
        // list (its `sharedRun` comes from tab files main-side).
        try {
          await useChatStore
            .getState()
            .setSharedRun(projectId, worktreeId, target.chatId, sharedRun);
        } catch {
          const hadExistingShare = target.existingShare !== undefined;
          try {
            await unshareRun(projectId, worktreeId, target.chatId);
          } catch {
            throw new Error(
              'Session shared, but its local status could not be saved or revoked. Retry sharing to restore local control.',
            );
          }
          setTarget((current) => {
            if (current?.chatId !== target.chatId) return current;
            const next = { ...current };
            delete next.existingShare;
            return next;
          });
          // `setSharedRun` restores previous metadata when its canonical write
          // fails. A rolled-back update therefore needs a second canonical
          // write to remove the now-revoked existing grant. Until that succeeds,
          // the committed dialog remains locked to completion-only recovery.
          if (hadExistingShare) {
            try {
              await useChatStore
                .getState()
                .setSharedRun(projectId, worktreeId, target.chatId, undefined);
            } catch {
              pendingCanonicalCleanupRef.current = {
                projectId,
                worktreeId,
                chatId: target.chatId,
              };
              throw new Error(
                'Session share was revoked, but its local status could not be cleared. Retry to finish cleaning up.',
              );
            }
          }
          throw new ShareCompletionRolledBackError(
            'Session share state could not be saved. The share was revoked; retry sharing.',
          );
        }
        if (isCoworkChatTarget(projectId)) {
          void useStandaloneChatStore.getState().refreshWorkEntries();
        }
        // The share dialog stays open on its success notice (with the link)
        // once this completion hook returns; Done closes it through `close`.
      }
    },
    [projectId, unshareRun, worktreeId, target],
  );

  return {
    target,
    entryVisible,
    open,
    close,
    submit,
    checkEligibility,
    onShared,
  };
}
