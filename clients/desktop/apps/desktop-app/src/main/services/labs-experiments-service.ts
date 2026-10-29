import {
  LABS_EXPERIMENTS,
  parseLabsExperimentFixtures,
  validateLabsExperiments,
  type LabsExperiment,
  type LabsExperimentsSnapshot,
} from '@canopy/desktop-shared/lib/labs-experiments';
import {
  EARLY_ACCESS_EXPERIMENT_ID,
  isLabsExperimentAvailability,
  labsExperimentChoiceRequestSchema,
  labsExperimentChoiceResultSchema,
  labsExperimentChoicesSchema,
  migrateExtractedLabsChoices,
  resolveLabsExperiment,
  type LabsExperimentAvailability,
  type LabsExperimentChoiceRequest,
} from '@canopy/protocol/experiments';
import { readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type {
  LabsAvailabilityFallbackPolicy,
  LabsAvailabilityState,
} from '../feature-flags/labs-availability';
import { resolveLabsAvailability } from '../feature-flags/labs-availability';
import { writeFileAtomically } from '../lib/atomic-file';
import { setExperimentalFeaturesEnabled } from '../lib/experimental-features';
import {
  getLabsExperimentAvailabilityCachePath,
  getLabsExperimentChoicesPath,
} from '../lib/paths';

const choicesFileSchema = z.strictObject({
  version: z.literal(1),
  accounts: z.record(z.string(), labsExperimentChoicesSchema),
});
const availabilityFileSchema = z.strictObject({
  version: z.literal(1),
  contexts: z.record(
    z.string().regex(/^[a-f0-9]{64}$/),
    z.record(z.string(), z.enum(['hidden', 'offered', 'on'])),
  ),
});
type ChoicesFile = z.output<typeof choicesFileSchema>;
type AvailabilityFile = z.output<typeof availabilityFileSchema>;
export interface LabsAccountSession {
  scope: string;
  signedIn: boolean;
  ready: boolean;
}
export interface LabsExperimentsDependencies {
  choicesPath: string;
  availabilityPath: string;
  read(path: string): unknown;
  write(path: string, data: string): Promise<void>;
  availability(): LabsAvailabilityState;
  availabilityFallback?: LabsAvailabilityFallbackPolicy;
  fetchChoices(session: LabsAccountSession): Promise<unknown>;
  putChoice(
    session: LabsAccountSession,
    request: LabsExperimentChoiceRequest,
  ): Promise<unknown>;
  diagnostic(error: unknown): void;
  mirror(enabled: boolean): void;
}
export class LabsExperimentError extends Error {
  constructor(
    readonly code:
      | 'invalid_payload'
      | 'missing_capability'
      | 'surface_unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** One main-owned evaluator and writer for all windows and agent actions. */
export class LabsExperimentsService {
  private accounts: ChoicesFile['accounts'];
  private contexts: AvailabilityFile['contexts'];
  private session: LabsAccountSession;
  private generation = 0;
  private revision = 0;
  private choicesReady = false;
  private listeners = new Set<(snapshot: LabsExperimentsSnapshot) => void>();
  private writes = new Map<string, Promise<unknown>>();
  private loads = new Set<Promise<void>>();
  private writeVersions = new Map<string, number>();
  private persistence: Promise<unknown> = Promise.resolve();
  private snapshot: LabsExperimentsSnapshot;

  constructor(
    private readonly deps: LabsExperimentsDependencies,
    session: LabsAccountSession,
    private readonly entries: readonly LabsExperiment[] = LABS_EXPERIMENTS,
  ) {
    validateLabsExperiments(entries, true);
    this.session = { ...session };
    const rawChoices = deps.read(deps.choicesPath);
    const parsedChoices = choicesFileSchema.safeParse(rawChoices);
    const cachedAccounts = parsedChoices.data?.accounts ?? {};
    // The old choice is already durable. Materialize the same preference in
    // its own scope before any later mutation of Early access can change it.
    this.accounts = Object.fromEntries(
      Object.entries(cachedAccounts).map(([scope, choices]) => [
        scope,
        migrateExtractedLabsChoices(choices),
      ]),
    );
    if (
      !session.signedIn &&
      !Object.prototype.hasOwnProperty.call(this.accounts, session.scope)
    )
      this.accounts[session.scope] = migrateExtractedLabsChoices({});
    this.contexts = Object.fromEntries(
      Object.entries(
        availabilityFileSchema.safeParse(deps.read(deps.availabilityPath)).data
          ?.contexts ?? {},
      ).slice(-32),
    );
    this.choicesReady = !session.signedIn;
    this.snapshot = this.evaluate();
    deps.mirror(this.snapshot.earlyAccessEnabled);
    if (
      (parsedChoices.success || rawChoices === undefined) &&
      JSON.stringify(cachedAccounts) !== JSON.stringify(this.accounts)
    ) {
      const write = deps.write.bind(deps);
      const data = JSON.stringify({ version: 1, accounts: this.accounts });
      // Serialize this durable upgrade ahead of normal saves. The initial
      // effective value is unchanged from the already durable old preference.
      void this.queuePersistence(() => write(deps.choicesPath, data)).catch(
        (error) => deps.diagnostic(error),
      );
    }
  }
  getSnapshot(): LabsExperimentsSnapshot {
    return structuredClone(this.snapshot);
  }
  onSnapshotChanged(
    listener: (snapshot: LabsExperimentsSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }
  activate(session: LabsAccountSession): Promise<void> {
    this.generation++;
    this.session = { ...session };
    if (
      !session.signedIn &&
      !Object.prototype.hasOwnProperty.call(this.accounts, session.scope)
    )
      this.accounts[session.scope] = migrateExtractedLabsChoices({});
    this.choicesReady = !session.signedIn;
    this.publish();
    return this.refreshChoices();
  }
  refreshChoices(): Promise<void> {
    const load = this.loadChoices();
    this.loads.add(load);
    void load
      .finally(() => {
        this.loads.delete(load);
      })
      .catch(() => undefined);
    return load;
  }
  private async loadChoices(): Promise<void> {
    const session = this.session;
    const generation = this.generation;
    if (!session.signedIn || !session.ready) return;
    await this.writes.get(session.scope)?.catch(() => undefined);
    if (generation !== this.generation) return;
    const version = this.writeVersions.get(session.scope) ?? 0;
    try {
      const response = z
        .strictObject({ choices: labsExperimentChoicesSchema })
        .parse(await this.deps.fetchChoices(session));
      if (
        generation !== this.generation ||
        version !== (this.writeVersions.get(session.scope) ?? 0)
      )
        return;
      this.accounts = { ...this.accounts, [session.scope]: response.choices };
      this.choicesReady = true;
      this.publish();
      await this.persistChoices();
    } catch (error) {
      this.deps.diagnostic(error);
      if (
        generation === this.generation &&
        version === (this.writeVersions.get(session.scope) ?? 0)
      ) {
        this.choicesReady = true;
        this.publish();
      }
    }
  }
  availabilityChanged(): void {
    const state = this.deps.availability();
    if (state.contextIdentity) {
      const cached = Object.prototype.hasOwnProperty.call(
        this.contexts,
        state.contextIdentity,
      )
        ? (this.contexts[state.contextIdentity] ?? {})
        : {};
      const values: Record<string, LabsExperimentAvailability> = { ...cached };
      for (const entry of this.entries) {
        const live = state.liveValues[entry.flagKey];
        if (
          entry.fixtureAvailability === undefined &&
          isLabsExperimentAvailability(live)
        )
          values[entry.flagKey] = live;
      }
      if (JSON.stringify(values) !== JSON.stringify(cached)) {
        const contexts = { ...this.contexts };
        delete contexts[state.contextIdentity];
        contexts[state.contextIdentity] = values;
        this.contexts = Object.fromEntries(Object.entries(contexts).slice(-32));
        void this.queuePersistence(() =>
          this.deps.write(
            this.deps.availabilityPath,
            JSON.stringify({ version: 1, contexts: this.contexts }),
          ),
        ).catch((error) => this.deps.diagnostic(error));
      }
    }
    this.publish();
  }
  setChoice(
    raw: LabsExperimentChoiceRequest,
  ): Promise<LabsExperimentsSnapshot> {
    const request = labsExperimentChoiceRequestSchema.safeParse(raw);
    if (!request.success)
      return Promise.reject(
        new LabsExperimentError(
          'invalid_payload',
          'Invalid experiment choice.',
        ),
      );
    const session = this.session;
    const generation = this.generation;
    this.writeVersions.set(
      session.scope,
      (this.writeVersions.get(session.scope) ?? 0) + 1,
    );
    const previous = this.writes.get(session.scope) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async (): Promise<LabsExperimentsSnapshot> => {
        this.assertGeneration(generation);
        const current = this.snapshot.experiments.find(
          (entry) => entry.id === request.data.experimentId,
        );
        if (!current)
          throw new LabsExperimentError(
            'invalid_payload',
            'Unknown experiment.',
          );
        if (!this.snapshot.ready || !session.ready)
          throw new LabsExperimentError(
            'surface_unavailable',
            'Experiment state is not ready.',
          );
        if (
          current.availability === 'hidden' ||
          (current.requiresEarlyAccess &&
            request.data.enabled &&
            !this.snapshot.earlyAccessEnabled)
        )
          throw new LabsExperimentError(
            'missing_capability',
            'Experiment is unavailable.',
          );
        if (session.signedIn) {
          let committedChoices: Record<string, boolean> | undefined;
          try {
            const result = labsExperimentChoiceResultSchema.parse(
              await this.deps.putChoice(session, request.data),
            );
            if (
              result.experimentId !== request.data.experimentId ||
              result.enabled !== request.data.enabled ||
              (result.choices !== undefined &&
                result.choices[request.data.experimentId] !==
                  request.data.enabled)
            )
              throw new Error('Invalid experiment choice response.');
            committedChoices = result.choices;
          } catch (error) {
            // An idempotent PUT can commit before its response is lost. A GET
            // reconciles the complete server state without replaying the write.
            this.assertGeneration(generation);
            try {
              const result = z
                .strictObject({ choices: labsExperimentChoicesSchema })
                .parse(await this.deps.fetchChoices(session));
              this.assertGeneration(generation);
              this.accounts = {
                ...this.accounts,
                [session.scope]: result.choices,
              };
              this.choicesReady = true;
              this.publish();
              await this.persistChoices().catch((cacheError) =>
                this.deps.diagnostic(cacheError),
              );
              if (
                result.choices[request.data.experimentId] ===
                request.data.enabled
              )
                return this.getSnapshot();
            } catch (loadError) {
              this.deps.diagnostic(loadError);
            }
            throw error;
          }
          this.assertGeneration(generation);
          this.accounts = {
            ...this.accounts,
            [session.scope]: committedChoices ?? {
              ...this.accountChoices(session.scope),
              [request.data.experimentId]: request.data.enabled,
            },
          };
          this.choicesReady = true;
          this.publish();
          await this.persistChoices().catch((error) =>
            this.deps.diagnostic(error),
          );
        } else {
          await this.queuePersistence(async (): Promise<void> => {
            this.assertGeneration(generation);
            const accounts = {
              ...this.accounts,
              [session.scope]: {
                ...this.accountChoices(session.scope),
                [request.data.experimentId]: request.data.enabled,
              },
            };
            await this.deps.write(
              this.deps.choicesPath,
              JSON.stringify({ version: 1, accounts }),
            );
            this.accounts = {
              ...this.accounts,
              [session.scope]: accounts[session.scope] ?? {},
            };
          });
          this.assertGeneration(generation);
          this.publish();
        }
        this.assertGeneration(generation);
        return this.getSnapshot();
      });
    this.writes.set(session.scope, write);
    void write
      .finally(() => {
        if (this.writes.get(session.scope) === write)
          this.writes.delete(session.scope);
      })
      .catch(() => undefined);
    return write;
  }
  async flush(): Promise<void> {
    await Promise.allSettled([
      ...Array.from(this.writes.values()),
      ...Array.from(this.loads),
    ]);
    await this.persistence;
  }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation)
      throw new LabsExperimentError(
        'surface_unavailable',
        'Account changed during the request.',
      );
  }
  private accountChoices(scope: string): Record<string, boolean> {
    return Object.prototype.hasOwnProperty.call(this.accounts, scope)
      ? (this.accounts[scope] ?? {})
      : {};
  }
  private queuePersistence(operation: () => Promise<void>): Promise<void> {
    const pending = this.persistence.catch(() => undefined).then(operation);
    this.persistence = pending;
    return pending;
  }
  private persistChoices(): Promise<void> {
    return this.queuePersistence(() =>
      this.deps.write(
        this.deps.choicesPath,
        JSON.stringify({ version: 1, accounts: this.accounts }),
      ),
    );
  }
  private evaluate(): LabsExperimentsSnapshot {
    const state = this.deps.availability();
    const cached =
      state.contextIdentity &&
      Object.prototype.hasOwnProperty.call(this.contexts, state.contextIdentity)
        ? (this.contexts[state.contextIdentity] ?? {})
        : {};
    const choices = this.accountChoices(this.session.scope);
    const ready =
      this.session.ready &&
      (state.snapshot.status === 'not_configured' ||
        state.contextIdentity !== null ||
        Object.keys(state.liveValues).length > 0);
    const availability = (entry: LabsExperiment): LabsExperimentAvailability =>
      resolveLabsAvailability(
        entry,
        state,
        cached,
        this.deps.availabilityFallback,
      );
    const choice = (id: string): boolean | null =>
      Object.prototype.hasOwnProperty.call(choices, id)
        ? (choices[id] ?? null)
        : null;
    const early = this.entries.find(
      (entry) => entry.id === EARLY_ACCESS_EXPERIMENT_ID,
    );
    const earlyAccessEnabled =
      ready &&
      !!early &&
      resolveLabsExperiment({
        availability: availability(early),
        choice: choice(early.id),
        earlyAccessEnabled: false,
        requiresEarlyAccess: false,
      }).enabled;
    return {
      generation: this.generation,
      revision: this.revision,
      scope: this.session.scope,
      ready,
      choicesReady: this.choicesReady,
      earlyAccessEnabled,
      updatedAt: new Date().toISOString(),
      experiments: this.entries.map((entry) => ({
        ...entry,
        pages: [...entry.pages],
        sidebarKeys: [...entry.sidebarKeys],
        availability: availability(entry),
        choice: choice(entry.id),
        ...(!ready
          ? { listed: false, enabled: false }
          : resolveLabsExperiment({
              availability: availability(entry),
              choice: choice(entry.id),
              earlyAccessEnabled,
              requiresEarlyAccess: entry.requiresEarlyAccess,
            })),
      })),
    };
  }
  private publish(): void {
    this.revision++;
    this.snapshot = this.evaluate();
    try {
      this.deps.mirror(this.snapshot.earlyAccessEnabled);
    } catch (error) {
      this.deps.diagnostic(error);
    }
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(this.getSnapshot());
      } catch (error) {
        this.deps.diagnostic(error);
      }
    }
  }
}

function readCache(path: string): unknown {
  try {
    if (statSync(path).size > 512 * 1024) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    return null;
  }
}
export function labsExperimentRegistry(): readonly LabsExperiment[] {
  if (__CANOPY_E2E__ && process.env.CANOPY_E2E_LABS_EXPERIMENTS)
    return [
      ...LABS_EXPERIMENTS,
      ...parseLabsExperimentFixtures(
        JSON.parse(process.env.CANOPY_E2E_LABS_EXPERIMENTS),
      ),
    ];
  return LABS_EXPERIMENTS;
}
export function labsExperimentStorageDependencies(): Pick<
  LabsExperimentsDependencies,
  'choicesPath' | 'availabilityPath' | 'read' | 'write' | 'mirror'
> {
  return {
    choicesPath: getLabsExperimentChoicesPath(),
    availabilityPath: getLabsExperimentAvailabilityCachePath(),
    read: readCache,
    write: async (path, data): Promise<void> => {
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomically(path, data, {
        durable: true,
        encoding: 'utf8',
        mode: 0o600,
      });
    },
    mirror: setExperimentalFeaturesEnabled,
  };
}
