import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ONBOARDING_CHECKLIST_ITEM_IDS,
  ONBOARDING_CHECKLIST_PROVIDERS,
} from '@canopy/desktop-shared/types';
import type {
  OnboardingChecklistItemId,
  OnboardingChecklistProvider,
} from '@canopy/desktop-shared/types';
import { getOnboardingChecklistFilePath } from './paths';

/**
 * Durable state for the persistent sidebar onboarding checklist (CAN-788).
 *
 * Completion latches exist so "completed work stays complete": product state
 * that once satisfied an item (a successful pipeline run, an added
 * repository) can later disappear without un-completing the checklist, and
 * expensive backfill scans never need to repeat once their answer is
 * latched. This module is the only writer of the file; the in-memory cache
 * is therefore authoritative for the process lifetime and disk writes are
 * best-effort.
 */
const ONBOARDING_CHECKLIST_FILE_VERSION = 1;

export interface OnboardingChecklistPersistedState {
  /** ISO-8601 latch timestamps keyed by checklist item id. */
  completedItems: Partial<Record<OnboardingChecklistItemId, string>>;
  dismissedAt: string | null;
  snoozedUntil: string | null;
  providersNotUsed: OnboardingChecklistProvider[];
}

interface OnboardingChecklistFile extends OnboardingChecklistPersistedState {
  version: number;
  updatedAt: string;
}

export interface OnboardingChecklistMutationResult {
  state: OnboardingChecklistPersistedState;
  /** False when the mutation was a no-op (nothing persisted). */
  changed: boolean;
}

let stateCache: OnboardingChecklistPersistedState | null = null;
let stateLoad: Promise<OnboardingChecklistPersistedState> | null = null;
let writeChain: Promise<void> = Promise.resolve();

function emptyState(): OnboardingChecklistPersistedState {
  return {
    completedItems: {},
    dismissedAt: null,
    snoozedUntil: null,
    providersNotUsed: [],
  };
}

function cloneState(
  state: OnboardingChecklistPersistedState,
): OnboardingChecklistPersistedState {
  return {
    completedItems: { ...state.completedItems },
    dismissedAt: state.dismissedAt,
    snoozedUntil: state.snoozedUntil,
    providersNotUsed: [...state.providersNotUsed],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOnboardingChecklistItemId(
  value: unknown,
): value is OnboardingChecklistItemId {
  return (
    typeof value === 'string' &&
    (ONBOARDING_CHECKLIST_ITEM_IDS as readonly string[]).includes(value)
  );
}

function isOnboardingChecklistProvider(
  value: unknown,
): value is OnboardingChecklistProvider {
  return (
    typeof value === 'string' &&
    (ONBOARDING_CHECKLIST_PROVIDERS as readonly string[]).includes(value)
  );
}

function normalizeState(value: unknown): OnboardingChecklistPersistedState {
  const state = emptyState();
  if (!isRecord(value) || value.version !== ONBOARDING_CHECKLIST_FILE_VERSION) {
    return state;
  }
  if (isRecord(value.completedItems)) {
    for (const [itemId, latchedAt] of Object.entries(value.completedItems)) {
      if (
        isOnboardingChecklistItemId(itemId) &&
        typeof latchedAt === 'string'
      ) {
        state.completedItems[itemId] = latchedAt;
      }
    }
  }
  if (typeof value.dismissedAt === 'string') {
    state.dismissedAt = value.dismissedAt;
  }
  if (typeof value.snoozedUntil === 'string') {
    state.snoozedUntil = value.snoozedUntil;
  }
  if (Array.isArray(value.providersNotUsed)) {
    for (const provider of value.providersNotUsed) {
      if (
        isOnboardingChecklistProvider(provider) &&
        !state.providersNotUsed.includes(provider)
      ) {
        state.providersNotUsed.push(provider);
      }
    }
  }
  return state;
}

async function readStateFile(): Promise<OnboardingChecklistPersistedState> {
  try {
    const raw = await readFile(getOnboardingChecklistFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    // Missing or corrupt state falls back to "nothing latched yet"; live
    // product-state derivation re-completes items on the next evaluation.
    return emptyState();
  }
}

async function loadState(): Promise<OnboardingChecklistPersistedState> {
  if (stateCache !== null) return stateCache;
  stateLoad ??= readStateFile();
  const value = await stateLoad;
  stateCache ??= value;
  return stateCache;
}

function enqueueWrite(state: OnboardingChecklistPersistedState): void {
  const contents: OnboardingChecklistFile = {
    version: ONBOARDING_CHECKLIST_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    ...cloneState(state),
  };
  const attempt = async (): Promise<void> => {
    const filePath = getOnboardingChecklistFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  };
  // A failed write must not poison later writes; the in-memory state stays
  // authoritative and the next mutation retries persistence.
  writeChain = writeChain.then(attempt, attempt).catch(() => undefined);
}

/**
 * Mutations serialize on this chain: `mutateState` suspends at `await
 * loadState()`, so two concurrent callers (e.g. the `Promise.all` latch
 * fan-out in `computeOnboardingChecklistState`) would otherwise clone the
 * same base state and overwrite each other's `stateCache` assignment,
 * silently dropping all but the last latch.
 */
let mutationChain: Promise<unknown> = Promise.resolve();

function mutateState(
  mutate: (state: OnboardingChecklistPersistedState) => boolean,
): Promise<OnboardingChecklistMutationResult> {
  const run = async (): Promise<OnboardingChecklistMutationResult> => {
    const current = await loadState();
    const next = cloneState(current);
    const changed = mutate(next);
    if (!changed) {
      return { state: cloneState(current), changed: false };
    }
    stateCache = next;
    enqueueWrite(next);
    return { state: cloneState(next), changed: true };
  };
  const step = mutationChain.then(run, run);
  mutationChain = step.catch(() => undefined);
  return step;
}

export async function readOnboardingChecklistPersistedState(): Promise<OnboardingChecklistPersistedState> {
  return cloneState(await loadState());
}

export async function latchOnboardingChecklistItemComplete(
  itemId: OnboardingChecklistItemId,
): Promise<OnboardingChecklistMutationResult> {
  return mutateState((state) => {
    if (state.completedItems[itemId] !== undefined) return false;
    state.completedItems[itemId] = new Date().toISOString();
    return true;
  });
}

export async function setOnboardingChecklistDismissedAt(
  dismissedAt: string | null,
): Promise<OnboardingChecklistMutationResult> {
  return mutateState((state) => {
    if (state.dismissedAt === dismissedAt) return false;
    state.dismissedAt = dismissedAt;
    return true;
  });
}

export async function setOnboardingChecklistSnoozedUntil(
  snoozedUntil: string | null,
): Promise<OnboardingChecklistMutationResult> {
  return mutateState((state) => {
    if (state.snoozedUntil === snoozedUntil) return false;
    state.snoozedUntil = snoozedUntil;
    return true;
  });
}

export async function setOnboardingChecklistProviderNotUsed(
  provider: OnboardingChecklistProvider,
  notUsed: boolean,
): Promise<OnboardingChecklistMutationResult> {
  return mutateState((state) => {
    const marked = state.providersNotUsed.includes(provider);
    if (notUsed === marked) return false;
    if (notUsed) {
      state.providersNotUsed.push(provider);
    } else {
      state.providersNotUsed = state.providersNotUsed.filter(
        (entry) => entry !== provider,
      );
    }
    return true;
  });
}

export function resetOnboardingChecklistStateForTests(): void {
  stateCache = null;
  stateLoad = null;
  writeChain = Promise.resolve();
  mutationChain = Promise.resolve();
}
