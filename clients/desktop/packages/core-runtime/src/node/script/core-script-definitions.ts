import type {
  CanopyCallerDescriptor,
  CanopyErrorKind,
  CanopyInstructionHandler,
  CanopyQueryHandler,
  CanopyRetryDirective,
  CoreScriptErrorCode,
  CoreScriptSourceLayer,
  CoreScriptTarget,
} from '@canopy/protocol/canopy-core';
import { normalizeScriptInputMap } from '@canopy/protocol/scripts';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  listCoreScriptDefinitions,
  resolveLocalScriptMap,
  toCoreScriptDefinition,
  type CoreScriptLocalChange,
  type ResolvedScriptMap,
  type ScriptSourceMap,
} from './definitions';

export type { CoreScriptLocalChange } from './definitions';

/**
 * The host reads script sources with the precedence in `./definitions` and
 * applies changes through the existing W5 settings command; core never writes
 * a script source itself.
 */
export interface CoreScriptDefinitionsHost {
  resolve(target: CoreScriptTarget): Promise<ResolvedScriptMap>;
  readLocal(target: CoreScriptTarget): Promise<ScriptSourceMap | undefined>;
  /**
   * The revision a change to the target's own settings checks, when the host
   * keeps one.
   */
  localRevision(target: CoreScriptTarget): Promise<number | undefined>;
  /** One script's resolution and every layer that defines it, in one read. */
  inspect(
    target: CoreScriptTarget,
    name: string,
  ): Promise<{ resolved: ResolvedScriptMap; layers: CoreScriptSourceLayer[] }>;
  change(input: {
    target: CoreScriptTarget;
    change: CoreScriptLocalChange;
    idempotencyKey: string;
    expectedRevision?: number;
    caller: CanopyCallerDescriptor;
  }): Promise<void>;
  /** The script code for a host refusal; untyped errors are `internal`. */
  errorCode(error: unknown): CoreScriptErrorCode | undefined;
}

export interface CoreScriptDefinitionHandlers {
  queries: {
    'core.script.definition.list': CanopyQueryHandler<
      'core.script.definition.list',
      CanopyHandlerContext
    >;
    'core.script.definition.get': CanopyQueryHandler<
      'core.script.definition.get',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'core.script.definition.upsert': CanopyInstructionHandler<
      'core.script.definition.upsert',
      CanopyHandlerContext
    >;
    'core.script.definition.delete': CanopyInstructionHandler<
      'core.script.definition.delete',
      CanopyHandlerContext
    >;
  };
}

const ERRORS: Record<
  CoreScriptErrorCode,
  { kind: CanopyErrorKind; retry: CanopyRetryDirective }
> = {
  'core.script.notFound': { kind: 'not_found', retry: { kind: 'never' } },
  'core.script.invalidDefinition': {
    kind: 'invalid_argument',
    retry: { kind: 'never' },
  },
  'core.script.readOnly': {
    kind: 'failed_precondition',
    retry: { kind: 'never' },
  },
  'core.script.configurationUnavailable': {
    kind: 'failed_precondition',
    retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
  },
  'core.script.revisionConflict': {
    kind: 'conflict',
    retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
  },
  'core.script.idempotencyKeyReused': {
    kind: 'conflict',
    retry: { kind: 'never' },
  },
  'core.script.requestInProgress': {
    kind: 'unavailable',
    retry: { kind: 'same_idempotency_key' },
  },
  'core.script.recoveryRequired': {
    kind: 'failed_precondition',
    retry: { kind: 'never' },
  },
  'core.script.outcomeExpired': {
    kind: 'failed_precondition',
    retry: { kind: 'never' },
  },
};

// The original error stays the runtime cause so in-process projections can
// rethrow it with its exact message. Unclassified failures stay untyped and
// the dispatcher reports them as `internal`.
function typedError(error: unknown, host: CoreScriptDefinitionsHost): unknown {
  if (!(error instanceof Error) || !error.message) return error;
  const code = host.errorCode(error);
  if (!code) return error;
  return new CanopyOperationError(
    {
      ...ERRORS[code],
      code,
      message: error.message.slice(0, 4_096),
    },
    error,
  );
}

function idempotencyKey(context: CanopyHandlerContext): string {
  const key = context.metadata.idempotencyKey;
  // The dispatcher refuses a keyed instruction without a key first.
  if (!key) throw new Error('An idempotency key is required.');
  return key;
}

/**
 * `core.script.definition.*` over a host's script sources. Reads report what
 * a run would select without starting one; `upsert` and `delete` change only
 * the target's own settings, through the host's W5 settings command.
 */
export function createCoreScriptDefinitionHandlers(
  host: CoreScriptDefinitionsHost,
): CoreScriptDefinitionHandlers {
  const run = async <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await operation();
    } catch (error) {
      throw typedError(error, host);
    }
  };
  return {
    queries: {
      'core.script.definition.list': ({ target, layer }) =>
        run(async () => {
          if (layer !== 'local') {
            return {
              definitions: listCoreScriptDefinitions(
                await host.resolve(target),
              ),
            };
          }
          // Read first: a write in between makes it stale, never too new.
          const revision = await host.localRevision(target);
          const local = await host.readLocal(target);
          return {
            definitions: listCoreScriptDefinitions(
              resolveLocalScriptMap(local),
            ),
            settings: normalizeScriptInputMap(local) ?? {},
            ...(revision === undefined ? {} : { revision }),
          };
        }),
      'core.script.definition.get': ({ target, name }) =>
        run(async () => {
          const { resolved, layers } = await host.inspect(target, name);
          const field = resolved[name];
          return {
            name,
            definition: field ? toCoreScriptDefinition(name, field) : null,
            layers,
            effectiveCommand:
              layers.find((layer) => layer.status === 'active')?.command ??
              null,
          };
        }),
    },
    instructions: {
      'core.script.definition.upsert': (
        { target, name, value, expectedRevision },
        context,
      ) =>
        run(async () => {
          await host.change({
            target,
            change: { kind: 'set', name, value },
            idempotencyKey: idempotencyKey(context),
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            caller: context.caller,
          });
          return { name };
        }),
      'core.script.definition.delete': (
        { target, name, expectedRevision },
        context,
      ) =>
        run(async () => {
          await host.change({
            target,
            change: { kind: 'remove', name },
            idempotencyKey: idempotencyKey(context),
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            caller: context.caller,
          });
          return { name };
        }),
    },
  };
}
