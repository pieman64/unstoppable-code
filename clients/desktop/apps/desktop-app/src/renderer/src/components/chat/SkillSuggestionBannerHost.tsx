import { useCallback, useEffect, useState, type JSX } from 'react';
import { SkillSuggestionBanner } from '@canopy/ui-app';
import type {
  PendingSkillSuggestion,
  SkillSuggestionResolution,
} from '@canopy/desktop-shared/lib/skill-suggestions';
import { useCreateSkillFromSuggestion } from '@/lib/createSkillFromSuggestion';
import {
  forgetAcknowledgedSkillSuggestionResolutions,
  reportSkillSuggestionResolution,
  useBannerResolutionIntent,
  useSkillSuggestionsFlagEnabled,
} from '@/stores/skillSuggestionStore';

interface SkillSuggestionBannerHostProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** Hidden while a turn streams; a hidden banner is never reported shown. */
  streaming: boolean;
  /** Whether this composer is actually on screen (not a background mount). */
  isComposerVisible: () => boolean;
}

/**
 * Offers to turn a request the user keeps repeating into a skill (CAN-385).
 *
 * Main matches the turn, applies the throttles and owns the pending entry;
 * this host reads it for the chat and reports `shown` only once the banner is
 * really on screen, so a streaming or background composer never spends one
 * of the suggestion's shows.
 */
export function SkillSuggestionBannerHost({
  projectId,
  worktreeId,
  chatId,
  streaming,
  isComposerVisible,
}: SkillSuggestionBannerHostProps): JSX.Element | null {
  const flagEnabled = useSkillSuggestionsFlagEnabled();
  const originKey = JSON.stringify([projectId, worktreeId, chatId]);
  const [snapshot, setSnapshot] = useState<{
    originKey: string;
    pending: PendingSkillSuggestion | null;
  } | null>(null);
  const pending = snapshot?.originKey === originKey ? snapshot.pending : null;
  const resolutionIntent = useBannerResolutionIntent(pending?.id ?? null);
  const create = useCreateSkillFromSuggestion();

  // Read the chat's pending suggestion, and re-read whenever main says it
  // moved. Events without an origin (scans, modal resolutions) apply to all.
  useEffect(() => {
    if (!flagEnabled) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    let sequence = 0;
    const origin = { projectId, worktreeId, chatId };
    const load = (): void => {
      const currentSequence = ++sequence;
      window.skillSuggestions
        .getPending(origin)
        .then((result) => {
          if (cancelled || currentSequence !== sequence) return;
          if (result.success)
            forgetAcknowledgedSkillSuggestionResolutions(
              origin,
              result.data?.id ?? null,
            );
          setSnapshot({
            originKey,
            pending: result.success ? (result.data ?? null) : null,
          });
        })
        .catch(() => {
          if (!cancelled && currentSequence === sequence)
            setSnapshot({ originKey, pending: null });
        });
    };
    setSnapshot(null);
    load();
    const unsubscribe = window.skillSuggestions.onChanged((changed) => {
      const target = changed.origin;
      if (
        !target ||
        (target.projectId === projectId &&
          target.worktreeId === worktreeId &&
          target.chatId === chatId)
      )
        load();
    });
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, [chatId, flagEnabled, originKey, projectId, worktreeId]);

  const report = useCallback(
    (
      current: PendingSkillSuggestion,
      resolution: SkillSuggestionResolution,
    ) => {
      reportSkillSuggestionResolution({
        source: 'banner',
        projectId,
        worktreeId,
        chatId,
        pendingId: current.id,
        suggestionId: current.suggestion.id,
        resolution,
      });
    },
    [projectId, worktreeId, chatId],
  );

  const locallySettled =
    resolutionIntent !== undefined && resolutionIntent !== 'shown';
  const visible =
    flagEnabled && pending !== null && !streaming && !locallySettled;
  const pendingState = pending?.state ?? null;

  // A composer mounted behind another page becomes visible without any of
  // this host's inputs changing, so the check runs after every render while
  // the entry is unreported; `report` sends each resolution once.
  useEffect(() => {
    if (!pending || !visible || pendingState !== 'pending') return;
    if (!isComposerVisible()) return;
    report(pending, 'shown');
  });

  if (!pending || !visible) return null;

  const { suggestion } = pending;
  return (
    <SkillSuggestionBanner
      count={suggestion.occurrenceCount}
      kind={suggestion.kind}
      chainSkills={suggestion.chainSkills}
      busy={create.pendingId !== null}
      onCreate={() => {
        create.start(suggestion, () => report(pending, 'accepted'));
      }}
      onDismiss={() => report(pending, 'dismissed')}
    />
  );
}
