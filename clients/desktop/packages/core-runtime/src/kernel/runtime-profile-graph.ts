import type {
  CanopyCallerDescriptor,
  CanopyInstructionDefinitionMap,
  CanopyQueryDefinitionMap,
  CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../runtime/dispatcher';
import type {
  CanopyDispatcher,
  CanopyDispatcherHandlerMap,
  CanopyDispatcherInstructionHandlerMap,
  CanopyDispatcherStreamHandlerMap,
  CanopyHandlerContext,
  CanopyRuntimeDefinitionMaps,
  CanopyRuntimeProfile,
  CanopyStreamSink,
} from '../runtime/types';
import {
  createCanopyRuntime,
  type CanopyRuntime,
  type CanopyRuntimeIdentity,
  type CreateCanopyRuntimeOptions,
} from './canopy-runtime';
import {
  createOperationRegistry,
  type RuntimeOperationOwner,
} from './operation-registry';
import { runtimeProfileInstalls } from './runtime-profile-manifest';
import {
  createInProcessWorkerBinding,
  type WorkerBindingPair,
} from '../runtime/in-process-worker-binding';
import {
  createServiceContainer,
  type RuntimeService,
} from './service-container';
import {
  createShutdownSequence,
  type ShutdownPhase,
} from './shutdown-sequence';

type Plane = RuntimeService['plane'];
// Method-derived signatures are bivariant, so the typed maps accepted by
// `defineRuntimeModule` widen without casts; the dispatcher still validates
// params and results against each definition's schemas.
type ModuleHandler = {
  run(params: unknown, context: CanopyHandlerContext): unknown;
}['run'];
type ModuleStreamHandler = {
  run(
    params: unknown,
    context: CanopyHandlerContext,
    sink: CanopyStreamSink<unknown>,
  ): Promise<(() => void) | void>;
}['run'];

export type RuntimeModuleDefinitions = CanopyRuntimeDefinitionMaps<
  CanopyQueryDefinitionMap,
  CanopyInstructionDefinitionMap,
  CanopyStreamDefinitionMap
>;
export interface RuntimeModuleHandlers {
  queries: Readonly<Record<string, ModuleHandler>>;
  instructions: Readonly<Record<string, ModuleHandler>>;
  streams: Readonly<Record<string, ModuleStreamHandler>>;
}

/** One plane's domain slice: its operations, handlers, and services. */
export interface RuntimeModule {
  name: string;
  plane: Plane;
  /** Host-declared provider dependency; concrete composition roots must also check imports at build time. */
  providerSdk?: boolean;
  services?: readonly RuntimeService[];
  definitions: RuntimeModuleDefinitions;
  handlers: RuntimeModuleHandlers;
}

export function defineRuntimeModule<
  const Q extends CanopyQueryDefinitionMap,
  const I extends CanopyInstructionDefinitionMap,
  const S extends CanopyStreamDefinitionMap,
>(
  module: Omit<RuntimeModule, 'definitions' | 'handlers'> & {
    definitions: CanopyRuntimeDefinitionMaps<Q, I, S>;
    handlers: {
      queries: CanopyDispatcherHandlerMap<Q>;
      instructions: CanopyDispatcherInstructionHandlerMap<I>;
      streams: CanopyDispatcherStreamHandlerMap<S>;
    };
  },
): RuntimeModule {
  return module;
}

export interface CreateRuntimeProfileGraphOptions {
  profile: CanopyRuntimeProfile;
  identity: CanopyRuntimeIdentity;
  modules: readonly RuntimeModule[];
  /** Per shutdown phase; phase 3 must outlast `shutdownTimeoutMs`. */
  phaseDeadlineMs: number;
  shutdownTimeoutMs?: number;
  principalFor?: CreateCanopyRuntimeOptions<
    CanopyQueryDefinitionMap,
    CanopyInstructionDefinitionMap,
    CanopyStreamDefinitionMap,
    CanopyDispatcher
  >['principalFor'];
  /** Trusted owning-core identity and grants for the bundled worker boundary. */
  workerCaller?: CanopyCallerDescriptor;
  /** Required for bundled worker modules; the host supplies serialized envelopes. */
  workerBinding?: WorkerBindingPair;
}

interface ComposedModules {
  definitions: RuntimeModuleDefinitions;
  handlers: RuntimeModuleHandlers;
  owners: RuntimeOperationOwner[];
  services: RuntimeService[];
}

const KINDS = ['queries', 'instructions', 'streams'] as const;
const OPERATION_KINDS = {
  queries: 'query',
  instructions: 'instruction',
  streams: 'stream',
} as const;

/** Operation ownership and planes are checked by the operation registry. */
function composeModules(
  profile: CanopyRuntimeProfile,
  modules: readonly RuntimeModule[],
): ComposedModules {
  const composed: ComposedModules = {
    definitions: { queries: {}, instructions: {}, streams: {} },
    handlers: { queries: {}, instructions: {}, streams: {} },
    owners: [],
    services: [],
  };
  for (const { name, plane, providerSdk, services = [], ...maps } of modules) {
    if (profile !== 'core+worker' && profile !== plane)
      throw new Error(
        `Runtime profile ${profile} cannot host ${plane} module ${name}`,
      );
    if (plane === 'core' && providerSdk === true)
      throw new Error(`Core module ${name} cannot carry a provider SDK`);
    for (const service of services)
      if (service.plane !== plane)
        throw new Error(
          `Module ${name} cannot host ${service.plane} service ${service.name}`,
        );
    const operations: string[] = [];
    for (const kind of KINDS) {
      const names = Object.keys(maps.definitions[kind]);
      for (const operation of names)
        if (!runtimeProfileInstalls(profile, operation, OPERATION_KINDS[kind]))
          throw new Error(
            `Runtime profile ${profile} does not install ${operation}`,
          );
      const handled = Object.keys(maps.handlers[kind]);
      if (
        handled.length !== names.length ||
        !handled.every((op) => names.includes(op))
      )
        throw new Error(`Module ${name} must handle exactly its own ${kind}`);
      operations.push(...names);
      Object.assign(composed.definitions[kind], maps.definitions[kind]);
      Object.assign(composed.handlers[kind], maps.handlers[kind]);
    }
    composed.owners.push({ name, plane, operations });
    composed.services.push(...services);
  }
  return composed;
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => reject(new Error('Shutdown phase aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/** `core.runtime` is core-plane, so a worker graph mirrors its 7 phases. */
function createWorkerRuntime(
  options: CreateRuntimeProfileGraphOptions,
  { definitions, handlers, owners, services }: ComposedModules,
): CanopyRuntime<CanopyDispatcher> {
  const profile = 'worker';
  const operations = createOperationRegistry({ profile, definitions, owners });
  const container = createServiceContainer({ profile, services });
  const { shutdownTimeoutMs } = options;
  const dispatcher = createCanopyDispatcher({
    profile,
    definitions,
    handlers,
    shutdownTimeoutMs,
  });
  const phase = (
    id: ShutdownPhase['id'],
    name: string,
    run: ShutdownPhase['run'],
  ): ShutdownPhase => ({ id, name, deadlineMs: options.phaseDeadlineMs, run });
  const sequence = createShutdownSequence({
    phases: [
      phase(1, 'drain-instructions', () => dispatcher.drainInstructions()),
      phase(2, 'publish-stopping', () => container.markStopping()),
      phase(3, 'cancel-work', async (signal) => {
        try {
          await Promise.race([dispatcher.shutdown(), untilAborted(signal)]);
        } finally {
          await container.stopPhase(3, signal);
        }
      }),
      phase(4, 'stop-schedulers', (signal) => container.stopPhase(4, signal)),
      phase(5, 'stop-processes', (signal) => container.stopPhase(5, signal)),
      phase(6, 'flush', (signal) => container.stopPhase(6, signal)),
      phase(7, 'close-resources', (signal) => container.stopPhase(7, signal)),
    ],
  });
  return {
    dispatcher,
    operations,
    start: () => container.start(),
    health: () => container.health(),
    shutdown: (reason) => sequence.run(reason),
  };
}

/** Bundled worker modules run on a worker dispatcher behind the binding. */
function bindBundledWorker(options: CreateRuntimeProfileGraphOptions): {
  queries: Record<string, ModuleHandler>;
  worker: CanopyDispatcher | null;
  close: () => void;
} {
  const modules = options.modules.filter(({ plane }) => plane === 'worker');
  const { definitions, handlers } = composeModules('core+worker', modules);
  for (const name of [
    ...Object.keys(definitions.instructions),
    ...Object.keys(definitions.streams),
  ])
    throw new Error(`The in-process worker binding cannot carry ${name}`);
  const queries: Record<string, ModuleHandler> = {};
  if (modules.length === 0)
    return { queries, worker: null, close: () => undefined };
  if (options.workerCaller === undefined)
    throw new Error('Bundled worker modules require a workerCaller');
  if (options.workerBinding === undefined)
    throw new Error('Bundled worker modules require a workerBinding');
  const worker = createCanopyDispatcher({
    profile: 'worker',
    definitions,
    handlers,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  });
  const client = createInProcessWorkerBinding(
    worker,
    options.workerCaller,
    options.workerBinding,
  );
  for (const name of Object.keys(definitions.queries))
    queries[name] = (params, { metadata, signal }): Promise<unknown> =>
      client.query(name, params, { metadata, signal });
  return { queries, worker, close: () => client.close() };
}

/** Builds a `core`, `worker`, or bundled `core+worker` runtime from modules. */
export function createRuntimeProfileGraph(
  options: CreateRuntimeProfileGraphOptions,
): CanopyRuntime<CanopyDispatcher> {
  const { profile, shutdownTimeoutMs } = options;
  const composed = composeModules(profile, options.modules);
  if (profile === 'worker') return createWorkerRuntime(options, composed);
  return createCanopyRuntime({
    profile,
    identity: options.identity,
    definitions: composed.definitions,
    owners: composed.owners,
    services: composed.services,
    principalFor: options.principalFor,
    phaseDeadlineMs: options.phaseDeadlineMs,
    // Runs after the operation registry validated the whole graph.
    createDispatcher: (input) => {
      const definitions: RuntimeModuleDefinitions = input.definitions;
      const runtime: RuntimeModuleHandlers = {
        ...input.runtimeHandlers,
        instructions: {},
      };
      const {
        queries,
        worker,
        close: closeBinding,
      } = bindBundledWorker(options);
      const bundle = createCanopyDispatcher({
        profile: input.profile,
        definitions,
        handlers: {
          queries: {
            ...composed.handlers.queries,
            ...queries,
            ...runtime.queries,
          },
          instructions: composed.handlers.instructions,
          streams: { ...composed.handlers.streams, ...runtime.streams },
        },
        shutdownTimeoutMs,
      });
      if (worker === null) return bundle;
      const drain = bundle.drainInstructions.bind(bundle);
      const close = bundle.shutdown.bind(bundle);
      return Object.assign(bundle, {
        drainInstructions: (): void => {
          drain();
          worker.drainInstructions();
        },
        shutdown: async (): Promise<void> => {
          try {
            await close();
          } finally {
            closeBinding();
            await worker.shutdown();
          }
        },
      });
    },
  });
}
