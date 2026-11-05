import { useEffect } from 'react';
import { create } from 'zustand';
import {
  SKILL_SUGGESTION_MODAL_SOURCE,
  type ResolveSkillSuggestionRequest,
  type SkillSuggestion,
  type SkillSuggestionOrigin,
} from '@canopy/desktop-shared/lib/skill-suggestions';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Renderer state for repeat-task skill suggestions (CAN-385). Main owns the
 * suggestions and their throttles; this keeps the open list for the Settings
 * badge and modal, and the resolutions the user has decided but main has not
 * acknowledged yet, so a remount never re-shows a dismissed banner.
 */

interface ResolutionIntent {
  request: ResolveSkillSuggestionRequest;
  acknowledged: boolean;
  timer?: number;
}

interface SkillSuggestionState {
  /** Open suggestions across owners; `null` until the first read. */
  suggestions: readonly SkillSuggestion[] | null;
  /** Keyed by banner pending id or `modal:<suggestion id>`. */
  resolutions: Readonly<Record<string, ResolutionIntent>>;
  /** Whether the suggestions modal is open (Settings or App Advisor). */
  modalOpen: boolean;
  setModalOpen: (open: boolean) => void;
}

export const useSkillSuggestionStore = create<SkillSuggestionState>((set) => ({
  suggestions: null,
  resolutions: {},
  modalOpen: false,
  setModalOpen: (open): void => set({ modalOpen: open }),
}));

/** Whether the rollout flag allows skill suggestions on this desktop. */
export function useSkillSuggestionsFlagEnabled(): boolean {
  return useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key),
  );
}

function resolutionKey(request: ResolveSkillSuggestionRequest): string {
  return request.source === SKILL_SUGGESTION_MODAL_SOURCE
    ? `modal:${request.suggestionId}`
    : request.pendingId;
}

/** Send once at a time and retry failed saves even when the composer unmounts. */
export function reportSkillSuggestionResolution(
  request: ResolveSkillSuggestionRequest,
): void {
  const key = resolutionKey(request);
  const previous = useSkillSuggestionStore.getState().resolutions[key];
  if (previous) {
    if (previous.request.resolution === request.resolution) return;
    if (previous.request.resolution !== 'shown') return;
    if (previous.timer !== undefined) window.clearTimeout(previous.timer);
  }
  const intent: ResolutionIntent = { request, acknowledged: false };
  useSkillSuggestionStore.setState((state) => ({
    resolutions: { ...state.resolutions, [key]: intent },
    // A decided suggestion leaves the list at once; main confirms it later.
    suggestions:
      request.resolution === 'shown' || state.suggestions === null
        ? state.suggestions
        : state.suggestions.filter(
            (suggestion) => suggestion.id !== request.suggestionId,
          ),
  }));
  const isCurrent = (): boolean =>
    useSkillSuggestionStore.getState().resolutions[key] === intent;
  const send = (attempt: number): void => {
    if (!isCurrent()) return;
    const retry = (): void => {
      if (!isCurrent()) return;
      intent.timer = window.setTimeout(
        () => {
          delete intent.timer;
          send(attempt + 1);
        },
        Math.min(5_000 * 2 ** Math.min(attempt - 1, 4), 60_000),
      );
    };
    void window.skillSuggestions.resolve(request).then(
      (result) => {
        if (!isCurrent()) return;
        if (!result.success) {
          retry();
          return;
        }
        // data=false is a stale id: main already resolved or cleared it.
        intent.acknowledged = true;
      },
      () => {
        // Main rejects only a request it refuses (validation or sender), which
        // a resend cannot fix; a failed save returns success: false instead.
        if (isCurrent()) intent.acknowledged = true;
      },
    );
  };
  send(1);
}

/** The banner resolution decided for a chat's pending entry, if any. */
export function useBannerResolutionIntent(
  pendingId: string | null,
): ResolveSkillSuggestionRequest['resolution'] | undefined {
  return useSkillSuggestionStore((state) =>
    pendingId ? state.resolutions[pendingId]?.request.resolution : undefined,
  );
}

/** Release acknowledged banner intents once a read moves past them. */
export function forgetAcknowledgedSkillSuggestionResolutions(
  origin: SkillSuggestionOrigin,
  pendingId: string | null,
): void {
  useSkillSuggestionStore.setState((state) => {
    const resolutions = { ...state.resolutions };
    let changed = false;
    for (const [id, intent] of Object.entries(resolutions)) {
      const request = intent.request;
      if (
        intent.acknowledged &&
        id !== pendingId &&
        request.source === 'banner' &&
        request.projectId === origin.projectId &&
        request.worktreeId === origin.worktreeId &&
        request.chatId === origin.chatId
      ) {
        delete resolutions[id];
        changed = true;
      }
    }
    return changed ? { resolutions } : state;
  });
}

/** Drop open suggestions this window already decided but main still lists. */
function withoutDecided(
  suggestions: readonly SkillSuggestion[],
  resolutions: Readonly<Record<string, ResolutionIntent>>,
): SkillSuggestion[] {
  const decided = new Set(
    Object.values(resolutions)
      .filter((intent) => intent.request.resolution !== 'shown')
      .map((intent) => intent.request.suggestionId),
  );
  return suggestions.filter((suggestion) => !decided.has(suggestion.id));
}

/** Acknowledged modal decisions are released once main stops listing them. */
function withoutReleasedModalIntents(
  listed: readonly SkillSuggestion[],
  resolutions: Readonly<Record<string, ResolutionIntent>>,
): Readonly<Record<string, ResolutionIntent>> {
  const listedIds = new Set(listed.map((suggestion) => suggestion.id));
  const kept = Object.entries(resolutions).filter(
    ([, intent]) =>
      !intent.acknowledged ||
      intent.request.source !== SKILL_SUGGESTION_MODAL_SOURCE ||
      listedIds.has(intent.request.suggestionId),
  );
  return kept.length === Object.keys(resolutions).length
    ? resolutions
    : Object.fromEntries(kept);
}

let listSubscribers = 0;
let unsubscribeChanged: (() => void) | null = null;
let listSequence = 0;

function loadSuggestionList(): void {
  const sequence = ++listSequence;
  window.skillSuggestions.list().then(
    (result) => {
      if (sequence !== listSequence) return;
      const state = useSkillSuggestionStore.getState();
      if (!result.success) {
        useSkillSuggestionStore.setState({
          suggestions: state.suggestions ?? [],
        });
        return;
      }
      const listed = result.data ?? [];
      useSkillSuggestionStore.setState({
        suggestions: withoutDecided(listed, state.resolutions),
        resolutions: withoutReleasedModalIntents(listed, state.resolutions),
      });
    },
    () => {
      if (sequence !== listSequence) return;
      if (useSkillSuggestionStore.getState().suggestions === null)
        useSkillSuggestionStore.setState({ suggestions: [] });
    },
  );
}

/**
 * Keeps the open suggestion list current while any surface shows it. Main
 * emits `changed` on every scan, match and resolution; each one refetches.
 */
export function useOpenSkillSuggestions(
  active: boolean,
): readonly SkillSuggestion[] | null {
  useEffect(() => {
    if (!active) return;
    listSubscribers += 1;
    if (listSubscribers === 1) {
      unsubscribeChanged = window.skillSuggestions.onChanged(() =>
        loadSuggestionList(),
      );
    }
    loadSuggestionList();
    return (): void => {
      listSubscribers -= 1;
      if (listSubscribers === 0) {
        unsubscribeChanged?.();
        unsubscribeChanged = null;
      }
    };
  }, [active]);
  return useSkillSuggestionStore((state) => state.suggestions);
}
