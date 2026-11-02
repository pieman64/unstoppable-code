import {
  hasEscapeEnabledOverlay,
  subscribeOverlayStack,
} from '@canopy/ui-shared/components';
import {
  isResumePending,
  subscribeResumePending,
} from '@/lib/resume-lifecycle';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  isAutomaticPending,
  useReleaseHighlightsStore,
} from '@/stores/releaseHighlightsStore';
import {
  hasComposerDraft,
  isComposerFocused,
  watchComposerDrafts,
} from './composer-activity';
import {
  decidePresentation,
  type PresentationBlocker,
  type PresentationGateDecision,
} from './presentation-gate';
import { watchPresentationMilestones } from './presentation-milestones';

/**
 * Never stack on an open modal. `DialogModal` marks its overlay root; other
 * root dialogs (the App Advisor quick prompt) declare `role="dialog"` with
 * `aria-modal`; Settings is a full-window page tracked by navigation state
 * rather than a dialog element.
 */
const OPEN_MODAL_SELECTOR =
  '[data-canopy-overlay-root="modal"], [role="dialog"][aria-modal="true"]';

/**
 * Safety net only: overlay-stack, navigation, focus, and store events are the
 * expected way a blocker clears.
 */
export const BLOCKED_RECHECK_MS = 2_000;

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

export interface AutomaticPresentationController {
  /** Reports an interaction the document listeners cannot observe. */
  readonly noteInteraction: () => void;
  /** Requests a coalesced recheck of every gate. */
  readonly reevaluate: () => void;
  readonly dispose: () => void;
}

export interface AutomaticPresentationControllerOptions {
  /** Monotonic clock; defaults to `performance.now`. */
  readonly now?: () => number;
  /** Current startup readiness; tracking continues after it first becomes true. */
  readonly isReady?: () => boolean;
}

/**
 * Tracks interaction and blockers for the pending automatic release
 * highlights decision in one document, and presents the queued dialog once
 * {@link decidePresentation} allows it. The deferral and milestone history
 * live in the store; this controller holds only DOM resources and timers, so
 * the host creates one per tracking effect and disposes it on cleanup. A
 * remount resumes the same monotonic quiet deadline and pointer history.
 */
export function createAutomaticPresentationController(
  doc: Document,
  options: AutomaticPresentationControllerOptions = {},
): AutomaticPresentationController {
  const view = doc.defaultView ?? window;
  const now = options.now ?? ((): number => view.performance.now());
  let disposed = false;
  let scheduled = false;
  const generation = useReleaseHighlightsStore.getState().automaticGeneration;
  function isCurrent(): boolean {
    const state = useReleaseHighlightsStore.getState();
    return (
      !disposed &&
      state.automaticGeneration === generation &&
      isAutomaticPending(state.automaticStatus)
    );
  }
  let quietTimer: number | null = null;
  let safetyInterval: number | null = null;
  let focusOutTimer: number | null = null;

  function stateBlockers(): PresentationBlocker[] {
    const { automaticStatus, queued, presentation, automaticGate } =
      useReleaseHighlightsStore.getState();
    const blockers: PresentationBlocker[] = [];
    if (
      options.isReady?.() === false ||
      automaticStatus !== 'queued' ||
      queued === null ||
      presentation
    ) {
      blockers.push('not-queued');
    }
    if (useNavigationStore.getState().settingsOpen) blockers.push('overlay');
    if (isResumePending()) blockers.push('resume-pending');
    if (automaticGate.composing) blockers.push('composing');
    return blockers;
  }

  function domBlockers(): PresentationBlocker[] {
    const blockers: PresentationBlocker[] = [];
    if (
      doc.querySelector(OPEN_MODAL_SELECTOR) !== null ||
      hasEscapeEnabledOverlay(doc)
    ) {
      blockers.push('overlay');
    }
    if (doc.visibilityState !== 'visible' || !doc.hasFocus()) {
      blockers.push('background');
    }
    if (isComposerFocused(doc)) blockers.push('composer-focus');
    if (hasComposerDraft(doc)) blockers.push('composer-draft');
    return blockers;
  }

  function decide(): PresentationGateDecision {
    const { automaticGate } = useReleaseHighlightsStore.getState();
    const base = {
      deferred: automaticGate.deferred,
      milestoneArmed: automaticGate.milestoneArmed,
      lastInteractionAt: automaticGate.lastInteractionAt,
      now: now(),
    };
    const cheap = decidePresentation({ ...base, blockers: stateBlockers() });
    // Scan the DOM only when nothing cheaper already rules presentation out.
    if (cheap.action !== 'present') return cheap;
    return decidePresentation({ ...base, blockers: domBlockers() });
  }

  function clearQuietTimer(): void {
    if (quietTimer === null) return;
    view.clearTimeout(quietTimer);
    quietTimer = null;
  }

  function setSafetyInterval(active: boolean): void {
    if (active && safetyInterval === null) {
      safetyInterval = view.setInterval(reevaluate, BLOCKED_RECHECK_MS);
    } else if (!active && safetyInterval !== null) {
      view.clearInterval(safetyInterval);
      safetyInterval = null;
    }
  }

  function evaluate(): void {
    scheduled = false;
    if (!isCurrent()) return;
    clearQuietTimer();
    const decision = decide();
    if (decision.action === 'present') {
      setSafetyInterval(false);
      // The store rechecks rollout, queue, and presentation, so a duplicate
      // or stale attempt is a no-op.
      useReleaseHighlightsStore.getState().presentQueuedAutomatic();
      return;
    }
    if (decision.action === 'defer') {
      setSafetyInterval(false);
      return;
    }
    if (decision.delayMs !== undefined) {
      setSafetyInterval(false);
      quietTimer = view.setTimeout(evaluate, decision.delayMs);
      return;
    }
    const { automaticStatus } = useReleaseHighlightsStore.getState();
    setSafetyInterval(automaticStatus === 'queued');
  }

  function reevaluate(): void {
    if (!isCurrent() || scheduled) return;
    scheduled = true;
    queueMicrotask(evaluate);
  }

  function noteInteraction(): void {
    if (!isCurrent()) return;
    useReleaseHighlightsStore.getState().noteAutomaticInteraction(now());
    // A pending quiet timer recomputes the remaining time when it fires, so
    // high-frequency input never reschedules it.
    if (quietTimer === null) reevaluate();
  }

  const onInteraction = (): void => noteInteraction();
  const onPointerMove = (event: PointerEvent): void => {
    // Coordinates cannot tell physical from synthetic movement, so the first
    // position counts and only repeats of the same point are ignored.
    if (!isCurrent()) return;
    const { lastPointer } = useReleaseHighlightsStore.getState().automaticGate;
    if (
      lastPointer !== null &&
      lastPointer.x === event.clientX &&
      lastPointer.y === event.clientY
    )
      return;
    useReleaseHighlightsStore
      .getState()
      .noteAutomaticInteraction(now(), { x: event.clientX, y: event.clientY });
    if (quietTimer === null) reevaluate();
  };
  const onCompositionStart = (): void => {
    if (!isCurrent()) return;
    useReleaseHighlightsStore.getState().noteAutomaticComposition(true);
    noteInteraction();
  };
  const onCompositionEnd = (): void => {
    if (!isCurrent()) return;
    useReleaseHighlightsStore.getState().noteAutomaticComposition(false);
    reevaluate();
  };
  // Focus moves as focusout then focusin; recheck once the move has landed
  // so the dialog never opens in the gap between them.
  const onFocusOut = (): void => {
    if (focusOutTimer !== null) view.clearTimeout(focusOutTimer);
    focusOutTimer = view.setTimeout((): void => {
      focusOutTimer = null;
      reevaluate();
    }, 0);
  };

  const capture = { capture: true, passive: true } as const;
  for (const type of INTERACTION_EVENTS) {
    doc.addEventListener(type, onInteraction, capture);
  }
  doc.addEventListener('pointermove', onPointerMove, capture);
  doc.addEventListener('compositionstart', onCompositionStart, capture);
  doc.addEventListener('compositionend', onCompositionEnd, capture);
  doc.addEventListener('focusin', reevaluate, capture);
  doc.addEventListener('focusout', onFocusOut, capture);
  doc.addEventListener('visibilitychange', reevaluate);
  view.addEventListener('focus', reevaluate);
  view.addEventListener('blur', reevaluate);

  // Modals that skip the overlay stack still portal to <body>.
  const bodyObserver = new view.MutationObserver(reevaluate);
  if (doc.body) bodyObserver.observe(doc.body, { childList: true });

  const unsubscribes = [
    watchComposerDrafts(doc, reevaluate),
    subscribeOverlayStack(doc, reevaluate),
    subscribeResumePending(reevaluate),
    useReleaseHighlightsStore.subscribe((state, previous): void => {
      // Timestamp/pointer updates do not reschedule an existing quiet timer.
      // It reads the latest history at its deadline instead.
      if (
        state.automaticStatus !== previous.automaticStatus ||
        state.automaticGeneration !== previous.automaticGeneration ||
        state.queued !== previous.queued ||
        state.presentation !== previous.presentation ||
        state.automaticGate.deferred !== previous.automaticGate.deferred ||
        state.automaticGate.milestoneArmed !==
          previous.automaticGate.milestoneArmed ||
        state.automaticGate.composing !== previous.automaticGate.composing
      )
        reevaluate();
    }),
    useNavigationStore.subscribe((state, previous): void => {
      if (state.settingsOpen !== previous.settingsOpen) reevaluate();
    }),
    watchPresentationMilestones({
      watchAcceptedTurns:
        !useReleaseHighlightsStore.getState().automaticGate
          .acceptedTurnObserved,
      onAcceptedTurn: (): void => {
        if (!isCurrent()) return;
        useReleaseHighlightsStore.getState().noteAutomaticAcceptedTurn();
        reevaluate();
      },
      onInteraction: noteInteraction,
      onMilestone: (): void => {
        if (!isCurrent()) return;
        useReleaseHighlightsStore.getState().noteAutomaticMilestone();
        reevaluate();
      },
    }),
  ];

  reevaluate();

  return {
    noteInteraction,
    reevaluate,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      for (const type of INTERACTION_EVENTS) {
        doc.removeEventListener(type, onInteraction, capture);
      }
      doc.removeEventListener('pointermove', onPointerMove, capture);
      doc.removeEventListener('compositionstart', onCompositionStart, capture);
      doc.removeEventListener('compositionend', onCompositionEnd, capture);
      doc.removeEventListener('focusin', reevaluate, capture);
      doc.removeEventListener('focusout', onFocusOut, capture);
      doc.removeEventListener('visibilitychange', reevaluate);
      view.removeEventListener('focus', reevaluate);
      view.removeEventListener('blur', reevaluate);
      bodyObserver.disconnect();
      for (const unsubscribe of unsubscribes) unsubscribe();
      clearQuietTimer();
      setSafetyInterval(false);
      if (focusOutTimer !== null) view.clearTimeout(focusOutTimer);
    },
  };
}
