import {
  resetLabsExperimentsStoreForTest,
  useLabsExperimentsStore,
} from '@/stores/labsExperimentsStore';
import { useExperimentalFeaturesStore } from '@/stores/experimentalFeaturesStore';
import {
  EARLY_ACCESS_EXPERIMENT_ID,
  EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS,
  resolveLabsExperiment,
  type LabsExperimentAvailability,
} from '@canopy/protocol/experiments';
import {
  LABS_EXPERIMENTS,
  type LabsExperimentsSnapshot,
} from '@canopy/desktop-shared/lib/labs-experiments';
import type {
  LabsExperimentChoiceRequest,
  LabsExperimentsApi,
  NavigationPage,
} from '@canopy/desktop-shared/types';

export interface TestLabsExperiment {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly pages?: readonly NavigationPage[];
  readonly sidebarKeys?: readonly string[];
  /** Defaults to `true`, matching Early-access-gated fixtures. */
  readonly requiresEarlyAccess?: boolean;
  readonly availability?: LabsExperimentAvailability;
  readonly choice?: boolean | null;
}

/** The registry's page experiments, switched on. */
export function pageExperimentsOn(): TestLabsExperiment[] {
  return LABS_EXPERIMENTS.filter((entry) => entry.pages.length > 0).map(
    (entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      pages: entry.pages,
      sidebarKeys: entry.sidebarKeys,
      requiresEarlyAccess: entry.requiresEarlyAccess,
      choice: true,
    }),
  );
}

export interface TestLabsSnapshotOptions {
  /** Stored Early access choice under the default `offered` rollout. */
  readonly earlyAccess?: boolean | null;
  readonly earlyAccessAvailability?: LabsExperimentAvailability;
  readonly experiments?: readonly TestLabsExperiment[];
  readonly generation?: number;
  readonly revision?: number;
  readonly scope?: string;
  readonly ready?: boolean;
}

/**
 * A Labs snapshot shaped like main's, with listed/enabled resolved by the
 * shared resolver so tests never hand-write effective state.
 */
export function makeTestLabsSnapshot(
  options: TestLabsSnapshotOptions = {},
): LabsExperimentsSnapshot {
  const ready = options.ready ?? true;
  const earlyAccessRegistry = LABS_EXPERIMENTS[0];
  const earlyAccess: TestLabsExperiment = {
    id: EARLY_ACCESS_EXPERIMENT_ID,
    name: earlyAccessRegistry?.name,
    description: earlyAccessRegistry?.description,
    requiresEarlyAccess: false,
    availability: options.earlyAccessAvailability ?? 'offered',
    choice: options.earlyAccess ?? null,
  };
  const entries = [earlyAccess, ...(options.experiments ?? [])];
  const resolve = (
    entry: TestLabsExperiment,
    earlyAccessEnabled: boolean,
  ): { listed: boolean; enabled: boolean } =>
    ready
      ? resolveLabsExperiment({
          availability: entry.availability ?? 'offered',
          choice: entry.choice ?? null,
          earlyAccessEnabled,
          requiresEarlyAccess: entry.requiresEarlyAccess ?? true,
        })
      : { listed: false, enabled: false };
  const earlyAccessEnabled = resolve(earlyAccess, false).enabled;
  return {
    generation: options.generation ?? 1,
    revision: options.revision ?? 1,
    scope: options.scope ?? 'local',
    ready,
    choicesReady: ready,
    earlyAccessEnabled,
    updatedAt: '2026-10-14T00:00:00.000Z',
    experiments: entries.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      description: entry.description ?? `${entry.id} description`,
      pages: [...(entry.pages ?? [])],
      sidebarKeys: [...(entry.sidebarKeys ?? [])],
      flagKey: `test-${entry.id}`,
      requiresEarlyAccess: entry.requiresEarlyAccess ?? true,
      availability: entry.availability ?? 'offered',
      choice: entry.choice ?? null,
      ...resolve(entry, earlyAccessEnabled),
    })),
  };
}

export interface TestExperimentsBridge {
  readonly api: LabsExperimentsApi;
  /** Requests `setChoice` received, in order. */
  readonly requests: LabsExperimentChoiceRequest[];
  /** Delivers a main push to the subscribed renderer. */
  push(snapshot: LabsExperimentsSnapshot): void;
  /** Replaces what `getSnapshot` resolves with. */
  setCurrent(snapshot: LabsExperimentsSnapshot): void;
  /** Replaces how `setChoice` answers. */
  respondWith(
    handler: (
      request: LabsExperimentChoiceRequest,
    ) => Promise<LabsExperimentsSnapshot>,
  ): void;
  readonly subscriberCount: () => number;
}

/** A controllable `window.api.experiments` for renderer tests. */
export function createTestExperimentsBridge(
  initial: LabsExperimentsSnapshot = makeTestLabsSnapshot(),
): TestExperimentsBridge {
  let current = initial;
  const listeners = new Set<(snapshot: LabsExperimentsSnapshot) => void>();
  const requests: LabsExperimentChoiceRequest[] = [];
  let handler: (
    request: LabsExperimentChoiceRequest,
  ) => Promise<LabsExperimentsSnapshot> = () => Promise.resolve(current);
  return {
    api: {
      getSnapshot: () => Promise.resolve(current),
      setChoice: (request): Promise<LabsExperimentsSnapshot> => {
        requests.push(request);
        return handler(request);
      },
      onSnapshotChanged: (cb) => {
        listeners.add(cb);
        return (): void => {
          listeners.delete(cb);
        };
      },
    },
    requests,
    push: (snapshot): void => {
      current = snapshot;
      listeners.forEach((listener) => listener(snapshot));
    },
    setCurrent: (snapshot): void => {
      current = snapshot;
    },
    respondWith: (next): void => {
      handler = next;
    },
    subscriberCount: () => listeners.size,
  };
}

/** Seed the pre-split bundle in behavior tests; independence tests seed individual IDs. */
export function setTestEarlyAccessFeatures(state: {
  enabled?: boolean;
  hydrated?: boolean;
}): void {
  const current = useLabsExperimentsStore.getState();
  const enabled =
    state.enabled ?? current.snapshot?.earlyAccessEnabled ?? false;
  const hydrated = state.hydrated ?? true;
  if (!hydrated) {
    resetLabsExperimentsStoreForTest();
    useExperimentalFeaturesStore.setState({ enabled, hydrated });
    return;
  }
  useExperimentalFeaturesStore.setState({ enabled, hydrated });
  useLabsExperimentsStore.setState({
    hydrated,
    snapshot: makeTestLabsSnapshot({
      earlyAccess: enabled,
      ready: hydrated,
      revision: (current.snapshot?.revision ?? 0) + 1,
      experiments: LABS_EXPERIMENTS.filter((entry) =>
        EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS.includes(entry.id),
      ).map((entry) => ({ ...entry, choice: enabled })),
    }),
  });
}

/** Seed a real authoritative feature snapshot with every unspecified feature off. */
export function setTestLabsFeatures(
  choices: Readonly<Record<string, boolean>>,
): void {
  useLabsExperimentsStore.setState({
    hydrated: true,
    snapshot: makeTestLabsSnapshot({
      earlyAccess: false,
      experiments: LABS_EXPERIMENTS.filter(
        (entry) => entry.id !== EARLY_ACCESS_EXPERIMENT_ID,
      ).map((entry) => ({ ...entry, choice: choices[entry.id] === true })),
    }),
  });
}
