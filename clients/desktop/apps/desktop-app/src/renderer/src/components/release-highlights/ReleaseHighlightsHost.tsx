import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useEffect, useLayoutEffect, useMemo, useRef, type JSX } from 'react';
import { useOnboardingTipsStore } from '@canopy/app-state';
import { ReleaseHighlightsDialog } from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';
import {
  createAutomaticPresentationController,
  type AutomaticPresentationController,
} from '@/lib/release-highlights/presentation-controller';
import {
  isAutomaticPending,
  useReleaseHighlightsStore,
} from '@/stores/releaseHighlightsStore';

interface ReleaseHighlightsHostProps {
  /**
   * Startup gates (legal consent, cloud sign-in, hydration, platform checks)
   * have cleared. Automatic presentation waits for this.
   */
  readonly ready: boolean;
}

/**
 * App-root host for the "What's new" dialog. The automatic decision and its
 * single pending presentation live in the store, so Strict Mode effect
 * replay, remounts, and unmounts cannot run it twice or lose it. While that
 * decision is pending, a presentation controller defers it past any user
 * interaction until an idle milestone (CAN-5006).
 */
export function ReleaseHighlightsHost({
  ready,
}: ReleaseHighlightsHostProps): JSX.Element | null {
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key),
  );
  const initialSnapshot = useReleaseHighlightsStore((s) => s.initialSnapshot);
  const presentation = useReleaseHighlightsStore((s) => s.presentation);
  const automaticStatus = useReleaseHighlightsStore((s) => s.automaticStatus);
  const generation = useReleaseHighlightsStore((s) => s.automaticGeneration);
  const deferred = useReleaseHighlightsStore((s) => s.automaticGate.deferred);
  const milestoneArmed = useReleaseHighlightsStore(
    (s) => s.automaticGate.milestoneArmed,
  );
  const close = useReleaseHighlightsStore((s) => s.close);
  const trackingStarted = useReleaseHighlightsStore(
    (s) => s.automaticGate.trackingStarted,
  );
  const tracking =
    enabled &&
    (ready || trackingStarted) &&
    isAutomaticPending(automaticStatus);
  const currentReady = useRef(ready);
  const controllerRef = useRef<AutomaticPresentationController | null>(null);
  useLayoutEffect(() => {
    currentReady.current = ready;
    controllerRef.current?.reevaluate();
  }, [ready]);

  // Declared before the decision starts so the first interaction after the
  // startup gates clear is never missed; earlier ones do not count.
  useEffect(() => {
    if (!tracking) return undefined;
    useReleaseHighlightsStore.getState().noteAutomaticTrackingStarted();
    const controller = createAutomaticPresentationController(document, {
      isReady: (): boolean => currentReady.current,
    });
    controllerRef.current = controller;
    return (): void => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [tracking, generation]);

  useEffect(() => {
    if (!enabled || initialSnapshot === null || !ready) return;
    void useReleaseHighlightsStore.getState().startAutomaticDecision();
  }, [initialSnapshot, ready, enabled]);

  // An automatic presentation spends the session's notice budget: tips clear
  // before the dialog paints and wait for the user's next turn (CAN-5005).
  // A manual open is the user's choice and holds nothing.
  const holdTipsForNotice = useOnboardingTipsStore(
    (state) => state.holdForNotice,
  );
  useLayoutEffect(() => {
    if (enabled && presentation?.source === 'automatic') {
      holdTipsForNotice(`release-highlights:${presentation.id}`);
    }
  }, [enabled, holdTipsForNotice, presentation?.id, presentation?.source]);

  useEffect(() => {
    if (
      enabled &&
      presentation?.source === 'automatic' &&
      presentation.recordVersion !== null
    ) {
      // A queued store transition can be replaced before React commits it.
      // Persist only once the dialog has actually mounted, never on dismissal.
      useReleaseHighlightsStore
        .getState()
        .recordAutomaticPresentation(presentation.id);
    }
  }, [
    enabled,
    presentation?.id,
    presentation?.source,
    presentation?.recordVersion,
  ]);

  const uiState = useMemo(
    () =>
      !enabled || presentation === null
        ? null
        : {
            open: true,
            source: presentation.source,
            version: presentation.entry.version,
          },
    [enabled, presentation],
  );
  useCurrentUiStateReporter('releaseHighlights.dialog', uiState);

  const readiness = (
    <span
      hidden
      data-testid="release-highlights-host"
      data-status={automaticStatus}
      data-deferred={deferred}
      data-milestone={milestoneArmed}
    />
  );
  if (!enabled || presentation === null) return readiness;
  const { fullNotesUrl } = presentation;
  return (
    <>
      {readiness}
      <ReleaseHighlightsDialog
        key={presentation.id}
        appName={brandText.appName}
        entry={presentation.entry}
        onClose={close}
        onOpenFullNotes={
          fullNotesUrl === null
            ? undefined
            : (): Promise<void> =>
                window.api.browser.openExternal({ url: fullNotesUrl })
        }
      />
    </>
  );
}
