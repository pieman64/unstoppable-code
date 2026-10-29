import { create } from 'zustand';
import type {
  AppAdvisorJson,
  AppAdvisorUiStateEnvelope,
  AppAdvisorUiStateSnapshot,
} from '@canopy/desktop-shared/types';
import {
  fnv1aHex,
  stableStringify,
} from '@canopy/desktop-shared/lib/stable-hash';
import { buildCurrentUiStateSnapshot } from '@/lib/current-ui-state/buildCurrentUiStateSnapshot';

/**
 * Hard cap (bytes) on the serialized hidden-UI-state envelope sent to the
 * App Advisor. Lists that push the snapshot above this limit are collapsed
 * to counts so the assistant still sees the *shape* of the UI without
 * inflating prompt cost.
 */
const MAX_SERIALIZED_ENVELOPE_BYTES = 16 * 1024;

/**
 * Default empty envelope. Used until the first reporter or snapshot builder
 * has populated state — at which point {@link recomputeEnvelope} replaces
 * this with the real envelope.
 */
function emptyEnvelope(): AppAdvisorUiStateEnvelope {
  return {
    version: 1,
    revision: 0,
    capturedAt: new Date(0).toISOString(),
    digest: '00000000',
    snapshot: {
      activePage: 'home',
      archivedContainers: {
        count: 0,
        viewerOpen: false,
      },
      overlays: {
        commandPaletteOpen: false,
        fileSearchPaletteOpen: false,
        prPickerOpen: false,
        canopyPortalOpen: false,
        appAdvisorOpen: false,
      },
    },
  };
}

interface CurrentUiStateStore {
  /** Monotonically increasing revision; bumps only when the digest changes. */
  revision: number;
  /** Latest published envelope. */
  envelope: AppAdvisorUiStateEnvelope;
  /**
   * Component-local UI slices registered via {@link useCurrentUiStateReporter}.
   * The snapshot builder reads these alongside zustand stores to produce
   * the final snapshot.
   */
  slices: Record<string, AppAdvisorJson>;
  /**
   * Upsert (or clear when `value` is `null`) a named slice and recompute the
   * envelope. The envelope only advances if the resulting digest changed.
   */
  updateSlice(key: string, value: AppAdvisorJson | null): void;
  /**
   * Force a recompute after a tracked zustand store has changed but no slice
   * was updated. Idempotent — only bumps `revision` on a digest change.
   */
  recomputeEnvelope(): void;
  /** Snapshot the latest envelope without recomputing. */
  getEnvelope(): AppAdvisorUiStateEnvelope;
}

export const useCurrentUiStateStore = create<CurrentUiStateStore>(
  (set, get) => ({
    revision: 0,
    envelope: emptyEnvelope(),
    slices: {},
    updateSlice: (key, value): void => {
      const prev = get().slices;
      const nextSlices = { ...prev };
      if (value === null) {
        delete nextSlices[key];
      } else {
        nextSlices[key] = value;
      }
      const snapshot = buildCurrentUiStateSnapshot(nextSlices);
      const next = bumpEnvelopeIfChanged(get(), snapshot, nextSlices);
      if (next) set(next);
    },
    recomputeEnvelope: (): void => {
      const slices = get().slices;
      const snapshot = buildCurrentUiStateSnapshot(slices);
      const next = bumpEnvelopeIfChanged(get(), snapshot, slices);
      if (next) set(next);
    },
    getEnvelope: (): AppAdvisorUiStateEnvelope => get().envelope,
  }),
);

function bumpEnvelopeIfChanged(
  state: CurrentUiStateStore,
  rawSnapshot: AppAdvisorUiStateSnapshot,
  slices: Record<string, AppAdvisorJson>,
): Partial<CurrentUiStateStore> | null {
  const snapshot = clampSerializedSnapshot(rawSnapshot);
  const serialized = stableStringify(snapshot);
  const digest = fnv1aHex(serialized);
  if (digest === state.envelope.digest) {
    // Slices may have changed but the produced snapshot is byte-identical.
    if (slices !== state.slices) {
      return { slices };
    }
    return null;
  }
  const revision = state.revision + 1;
  const envelope: AppAdvisorUiStateEnvelope = {
    version: 1,
    revision,
    capturedAt: new Date().toISOString(),
    digest,
    snapshot,
  };
  return { revision, envelope, slices };
}

// ---------------------------------------------------------------------------
// Stable JSON + digest helpers
// ---------------------------------------------------------------------------

/**
 * If serialization exceeds {@link MAX_SERIALIZED_ENVELOPE_BYTES}, collapse
 * countable collections, shorten large strings, and finally drop optional
 * fields until the serialized envelope is guaranteed to fit under the cap.
 */
function clampSerializedSnapshot(
  snapshot: AppAdvisorUiStateSnapshot,
): AppAdvisorUiStateSnapshot {
  if (serializedEnvelopeLength(snapshot) <= MAX_SERIALIZED_ENVELOPE_BYTES) {
    return snapshot;
  }

  let next = collapseArrays(snapshot) as AppAdvisorUiStateSnapshot;
  // Availability is a bounded page vocabulary used as a contract by action
  // discovery, rather than a countable UI collection. Keep its array shape.
  next = { ...next, availablePages: snapshot.availablePages };
  if (serializedEnvelopeLength(next) <= MAX_SERIALIZED_ENVELOPE_BYTES) {
    return next;
  }

  for (const maxStringLength of [1024, 256, 64]) {
    next = truncateStrings(next, maxStringLength) as AppAdvisorUiStateSnapshot;
    if (serializedEnvelopeLength(next) <= MAX_SERIALIZED_ENVELOPE_BYTES) {
      return next;
    }
  }

  const optionalFields: Array<keyof AppAdvisorUiStateSnapshot> = [
    'canopyPortal',
    'terminal',
    'activeFile',
    'pipelineRunDetails',
    'activePipelineRun',
    'activePipeline',
    'activeChat',
    'selectedWorktree',
    'codeGraphPanel',
    'settings',
    'sidebar',
  ];
  for (const field of optionalFields) {
    next = { ...next, [field]: undefined };
    if (serializedEnvelopeLength(next) <= MAX_SERIALIZED_ENVELOPE_BYTES) {
      return next;
    }
  }

  const minimal: AppAdvisorUiStateSnapshot = {
    activePage: next.activePage,
    availablePages: next.availablePages,
    archivedContainers: next.archivedContainers,
    overlays: next.overlays,
  };
  return serializedEnvelopeLength(minimal) <= MAX_SERIALIZED_ENVELOPE_BYTES
    ? minimal
    : emptyEnvelope().snapshot;
}

function serializedEnvelopeLength(snapshot: AppAdvisorUiStateSnapshot): number {
  return utf8ByteLength(
    stableStringify({
      version: 1,
      revision: Number.MAX_SAFE_INTEGER,
      capturedAt: '9999-12-31T23:59:59.999Z',
      digest: 'ffffffff',
      snapshot,
    }),
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function collapseArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { count: value.length };
  }
  if (value !== null && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = collapseArrays(child);
    }
    return next;
  }
  return value;
}

function truncateStrings(value: unknown, maxLength: number): unknown {
  if (typeof value === 'string') {
    return value.length > maxLength
      ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => truncateStrings(child, maxLength));
  }
  if (value !== null && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = truncateStrings(child, maxLength);
    }
    return next;
  }
  return value;
}
