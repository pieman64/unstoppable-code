import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useEffect, useMemo, useRef, type JSX } from 'react';
import {
  hasEscapeEnabledOverlay,
  ReleaseHighlightsDialog,
} from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';
import { useNavigationStore } from '@/stores/navigationStore';
import { useReleaseHighlightsStore } from '@/stores/releaseHighlightsStore';

/**
 * Never stack on an open modal. `DialogModal` marks its overlay root; other
 * root dialogs (the App Advisor quick prompt) declare `role="dialog"` with
 * `aria-modal`; Settings is a full-window page tracked by navigation state
 * rather than a dialog element.
 */
const OPEN_MODAL_SELECTOR =
  '[data-canopy-overlay-root="modal"], [role="dialog"][aria-modal="true"]';

function hasOpenModal(doc: Document): boolean {
  return (
    doc.querySelector(OPEN_MODAL_SELECTOR) !== null ||
    useNavigationStore.getState().settingsOpen
  );
}

const BLOCKED_RECHECK_MS = 2_000;

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
 * replay, remounts, and unmounts cannot run it twice or lose it.
 */
export function ReleaseHighlightsHost({
  ready,
}: ReleaseHighlightsHostProps): JSX.Element | null {
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key),
  );
  const initialSnapshot = useReleaseHighlightsStore((s) => s.initialSnapshot);
  const queued = useReleaseHighlightsStore((s) => s.queued);
  const presentation = useReleaseHighlightsStore((s) => s.presentation);
  const automaticStatus = useReleaseHighlightsStore((s) => s.automaticStatus);
  const close = useReleaseHighlightsStore((s) => s.close);
  const settingsOpen = useNavigationStore((s) => s.settingsOpen);
  const readyRef = useRef(ready);
  readyRef.current = ready && enabled;

  useEffect(() => {
    if (!enabled || initialSnapshot === null || !ready) return;
    void useReleaseHighlightsStore.getState().startAutomaticDecision();
  }, [initialSnapshot, ready, enabled]);

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

  useEffect(() => {
    if (
      !enabled ||
      queued === null ||
      !ready ||
      settingsOpen ||
      presentation !== null
    ) {
      return undefined;
    }
    const tryPresent = (): boolean => {
      if (
        !readyRef.current ||
        hasOpenModal(document) ||
        hasEscapeEnabledOverlay(document)
      )
        return false;
      useReleaseHighlightsStore.getState().presentQueuedAutomatic();
      return true;
    };
    if (tryPresent()) return undefined;
    // Dialogs portal to <body>, so a direct-child observer sees them close;
    // the slow interval covers anything that unmounts some other way.
    const observer = new MutationObserver((): void => {
      if (tryPresent()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true });
    const interval = window.setInterval((): void => {
      if (tryPresent()) window.clearInterval(interval);
    }, BLOCKED_RECHECK_MS);
    return (): void => {
      observer.disconnect();
      window.clearInterval(interval);
    };
  }, [enabled, queued, ready, settingsOpen, presentation]);

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
