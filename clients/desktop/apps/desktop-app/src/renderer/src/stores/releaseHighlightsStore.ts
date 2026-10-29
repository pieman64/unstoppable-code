import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from './featureFlagsStore';
import { create } from 'zustand';
import {
  decideReleaseHighlights,
  parseReleaseVersion,
  compareReleaseVersions,
  type ReleaseNotesEntry,
} from '@canopy/protocol/release-notes';
import { loadDesktopReleaseNotesEntries } from '@/lib/release-highlights/release-notes-entries';
import {
  brandReleaseNotesEntry,
  recordReleaseHighlightsVersion,
  resolveReleaseNotesUrl,
} from '@/lib/release-highlights/release-highlights';

export type ReleaseHighlightsSource = 'automatic' | 'manual';

export interface ReleaseHighlightsPresentation {
  /** Bumps per presentation so late async results never touch a newer one. */
  readonly id: number;
  readonly source: ReleaseHighlightsSource;
  /** Branded entry. */
  readonly entry: ReleaseNotesEntry;
  readonly fullNotesUrl: string | null;
  /** Presented entry identity to record after the host commits the dialog. */
  readonly recordVersion: string | null;
}

/**
 * Eligibility facts captured from the app's FIRST preferences read, before
 * the legal gate or onboarding can change them during this session.
 */
export interface ReleaseHighlightsInitialSnapshot {
  readonly lastSeenVersion: string | null;
  readonly onboardingCompleted: boolean;
}

interface QueuedAutomaticPresentation {
  readonly entry: ReleaseNotesEntry;
  readonly version: string;
  readonly fullNotesUrl: string | null;
}

/**
 * One automatic decision per renderer session:
 * `idle` → `deciding` → (`queued` → `presented`) | `settled`.
 * `cancelled` means a manual open of the same release pre-empted the queue.
 */
export type ReleaseHighlightsAutomaticStatus =
  | 'idle'
  | 'deciding'
  | 'queued'
  | 'presented'
  | 'cancelled'
  | 'settled';

interface ReleaseHighlightsStore {
  entries: readonly ReleaseNotesEntry[];
  loadEntries: (
    version?: string,
  ) => Promise<readonly ReleaseNotesEntry[] | null>;
  initialSnapshot: ReleaseHighlightsInitialSnapshot | null;
  automaticStatus: ReleaseHighlightsAutomaticStatus;
  queued: QueuedAutomaticPresentation | null;
  presentation: ReleaseHighlightsPresentation | null;
  manuallyPresentedVersions: readonly string[];
  automaticallyPresentedVersions: readonly string[];
  /** Called by the host only after the automatic dialog commits. */
  recordAutomaticPresentation: (id: number) => void;
  /** First call wins; later preference reads never replace the snapshot. */
  captureInitialSnapshot: (snapshot: ReleaseHighlightsInitialSnapshot) => void;
  /** Idempotent: runs the automatic decision at most once per session. */
  startAutomaticDecision: () => Promise<void>;
  /** Presents the queued dialog; the mounted host records it as seen. */
  presentQueuedAutomatic: () => void;
  /**
   * Settings "What's new". Leaves automatic history alone, except when it
   * pre-empts the automatic presentation of the same release: the user has
   * seen those highlights, so the release is recorded instead of popping up
   * again on the next launch.
   */
  openManual: (entry: ReleaseNotesEntry) => void;
  close: () => void;
}

let nextPresentationId = 0;
let rolloutGeneration = 0;
function isEnabled(): boolean {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key);
}

async function readAppVersion(): Promise<string | null> {
  try {
    const version = await window.api.update.getAppVersion();
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

export const useReleaseHighlightsStore = create<ReleaseHighlightsStore>(
  (set, get) => ({
    entries: [],
    loadEntries: async (
      version,
    ): Promise<readonly ReleaseNotesEntry[] | null> => {
      if (!isEnabled()) return [];
      const generation = rolloutGeneration;
      const entries = await loadDesktopReleaseNotesEntries(version);
      if (!isEnabled() || generation !== rolloutGeneration) return null;
      if (entries !== null) set({ entries });
      return entries;
    },
    initialSnapshot: null,
    automaticStatus: 'idle',
    queued: null,
    presentation: null,
    manuallyPresentedVersions: [],
    automaticallyPresentedVersions: [],

    captureInitialSnapshot: (snapshot): void => {
      if (get().initialSnapshot !== null) return;
      set({ initialSnapshot: snapshot });
    },

    startAutomaticDecision: async (): Promise<void> => {
      const { initialSnapshot, automaticStatus } = get();
      if (
        !isEnabled() ||
        initialSnapshot === null ||
        automaticStatus !== 'idle'
      )
        return;
      const generation = rolloutGeneration;
      set({ automaticStatus: 'deciding' });

      const currentVersion = await readAppVersion();
      if (!isEnabled() || generation !== rolloutGeneration) return;
      if (currentVersion === null) {
        set({ automaticStatus: 'settled' });
        return;
      }
      const eligibility = {
        currentVersion,
        lastSeenVersion: initialSnapshot.lastSeenVersion,
        onboardingCompletedAtInitialSnapshot:
          initialSnapshot.onboardingCompleted,
      };
      const current = parseReleaseVersion(currentVersion);
      const previous = initialSnapshot.lastSeenVersion
        ? parseReleaseVersion(initialSnapshot.lastSeenVersion)
        : null;
      // No startup network work for prereleases, internal or already-seen builds.
      if (
        !current ||
        current.rc !== null ||
        get().automaticallyPresentedVersions.includes(current.normalized) ||
        (previous && compareReleaseVersions(current, previous) <= 0)
      ) {
        set({ automaticStatus: 'settled' });
        return;
      }
      const entries = await get().loadEntries(currentVersion);
      if (!isEnabled() || generation !== rolloutGeneration) return;
      if (entries === null) {
        set({ automaticStatus: 'settled' });
        return;
      }
      const decision = decideReleaseHighlights(eligibility, entries);
      if (decision.action === 'none') {
        set({ automaticStatus: 'settled' });
        return;
      }
      if (get().automaticStatus !== 'deciding') return;
      if (get().manuallyPresentedVersions.includes(decision.entry.version)) {
        // Already shown from Settings while the version was loading.
        set({ automaticStatus: 'cancelled' });
        await recordReleaseHighlightsVersion(decision.version);
        return;
      }
      const entry = brandReleaseNotesEntry(decision.entry);
      set({
        automaticStatus: 'queued',
        queued: { entry, version: decision.version, fullNotesUrl: null },
      });
      // The origin never gates the dialog; it only adds the notes action.
      const fullNotesUrl = await resolveReleaseNotesUrl(entry);
      if (fullNotesUrl === null) return;
      const { queued, presentation } = get();
      if (queued?.entry.version === entry.version) {
        set({ queued: { ...queued, fullNotesUrl } });
      } else if (
        presentation?.source === 'automatic' &&
        presentation.entry.version === entry.version &&
        presentation.fullNotesUrl === null
      ) {
        set({ presentation: { ...presentation, fullNotesUrl } });
      }
    },

    presentQueuedAutomatic: (): void => {
      const { queued, presentation, automaticStatus } = get();
      if (
        !isEnabled() ||
        !queued ||
        presentation ||
        automaticStatus !== 'queued'
      )
        return;
      nextPresentationId += 1;
      set({
        automaticStatus: 'presented',
        queued: null,
        presentation: {
          id: nextPresentationId,
          source: 'automatic',
          entry: queued.entry,
          fullNotesUrl: queued.fullNotesUrl,
          recordVersion: queued.version,
        },
      });
    },

    recordAutomaticPresentation: (id): void => {
      const { presentation, automaticallyPresentedVersions } = get();
      if (
        !isEnabled() ||
        presentation?.id !== id ||
        presentation.source !== 'automatic' ||
        presentation.recordVersion === null ||
        automaticallyPresentedVersions.includes(presentation.recordVersion)
      )
        return;
      // Preserve session history even if durable saving fails. A rollout
      // revocation clears presentation state, but cannot make seen notes new.
      set({
        automaticallyPresentedVersions: [
          ...automaticallyPresentedVersions,
          presentation.recordVersion,
        ],
      });
      void recordReleaseHighlightsVersion(presentation.recordVersion);
    },

    openManual: (rawEntry): void => {
      if (!isEnabled()) return;
      const entry = brandReleaseNotesEntry(rawEntry);
      nextPresentationId += 1;
      const id = nextPresentationId;
      const { queued } = get();
      const cancelsQueued =
        queued !== null && queued.entry.version === entry.version;
      if (cancelsQueued) {
        // The user chose to view this release, so it counts as seen now,
        // unlike the automatic path, which records only once its dialog has
        // mounted so a replaced transition never records.
        void recordReleaseHighlightsVersion(queued.version);
      }
      set({
        presentation: {
          id,
          source: 'manual',
          entry,
          fullNotesUrl: null,
          recordVersion: null,
        },
        manuallyPresentedVersions: [
          ...get().manuallyPresentedVersions,
          entry.version,
        ],
        ...(cancelsQueued
          ? { queued: null, automaticStatus: 'cancelled' as const }
          : {}),
      });
      void resolveReleaseNotesUrl(entry).then((fullNotesUrl): void => {
        const current = get().presentation;
        // A dismissed or replaced dialog is never reopened by a late origin.
        if (fullNotesUrl === null || current?.id !== id) return;
        set({ presentation: { ...current, fullNotesUrl } });
      });
    },

    close: (): void => {
      if (get().presentation !== null) set({ presentation: null });
    },
  }),
);

export function openReleaseHighlights(entry: ReleaseNotesEntry): void {
  useReleaseHighlightsStore.getState().openManual(entry);
}

// Revoke queued, displayed, and in-flight notes on a live flag disable.
useFeatureFlagsStore.subscribe((state, previous) => {
  const key = CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key;
  if (
    state.snapshot.values[key] === true ||
    previous.snapshot.values[key] !== true
  )
    return;
  rolloutGeneration += 1;
  useReleaseHighlightsStore.setState({
    entries: [],
    queued: null,
    presentation: null,
    automaticStatus: 'idle',
  });
});
