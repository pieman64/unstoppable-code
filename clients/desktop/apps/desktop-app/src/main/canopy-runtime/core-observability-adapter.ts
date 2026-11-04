import {
  createCoreObservabilityHandlers,
  type CoreObservabilityHandlers,
  type ObservabilityReadModel,
} from '@canopy/core-runtime/observability';

/*
 * Registers `core.observability.*` (CAN-4137) over the observability service
 * Electron main hosts, which is the single writer of the audit and usage
 * stores (CAN-4136, CAN-5078). Every client reads the same records through the
 * dispatcher. The service loads on the first call, never when the runtime is
 * built, and one audit journal serves every stream.
 */

type ReadModelResolver = () => Promise<ObservabilityReadModel>;

async function loadObservabilityReadModel(): Promise<ObservabilityReadModel> {
  const { getObservabilityService } = await import('../observability');
  return getObservabilityService();
}

export function createCoreObservabilityAdapter(
  readModel: ReadModelResolver = loadObservabilityReadModel,
): CoreObservabilityHandlers {
  let handlers: Promise<CoreObservabilityHandlers> | null = null;
  const resolve = (): Promise<CoreObservabilityHandlers> => {
    handlers ??= readModel().then((model) =>
      createCoreObservabilityHandlers(model),
    );
    return handlers;
  };
  return {
    queries: {
      'core.observability.audit.list': async (params, context) =>
        (await resolve()).queries['core.observability.audit.list'](
          params,
          context,
        ),
      'core.observability.audit.transcript.get': async (params, context) =>
        (await resolve()).queries['core.observability.audit.transcript.get'](
          params,
          context,
        ),
      'core.observability.usage.query': async (params, context) =>
        (await resolve()).queries['core.observability.usage.query'](
          params,
          context,
        ),
      'core.observability.summary.get': async (params, context) =>
        (await resolve()).queries['core.observability.summary.get'](
          params,
          context,
        ),
    },
    streams: {
      'core.observability.audit.events': async (params, context, sink) =>
        (await resolve()).streams['core.observability.audit.events'](
          params,
          context,
          sink,
        ),
    },
  };
}
