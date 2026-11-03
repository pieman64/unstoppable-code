import type { z } from 'zod';
import type { CanopyErrorPayload } from './errors';

import type {
  CanopyInstructionDefinition,
  CanopyQueryDefinition,
  CanopyStreamDefinition,
  CanopyStreamCursor,
} from './definitions';
import {
  composeCanopyInstructionRegistries,
  composeCanopyQueryRegistries,
  composeCanopyStreamRegistries,
} from './definitions';
import {
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_QUERY_DEFINITIONS,
  CORE_STREAM_DEFINITIONS,
} from './core/registry';
import {
  WORKER_INSTRUCTION_DEFINITIONS,
  WORKER_QUERY_DEFINITIONS,
  WORKER_STREAM_DEFINITIONS,
} from './worker/registry';

export const CANOPY_QUERY_DEFINITIONS = composeCanopyQueryRegistries(
  CORE_QUERY_DEFINITIONS,
  WORKER_QUERY_DEFINITIONS,
);
export const CANOPY_INSTRUCTION_DEFINITIONS =
  composeCanopyInstructionRegistries(
    CORE_INSTRUCTION_DEFINITIONS,
    WORKER_INSTRUCTION_DEFINITIONS,
  );
export const CANOPY_STREAM_DEFINITIONS = composeCanopyStreamRegistries(
  CORE_STREAM_DEFINITIONS,
  WORKER_STREAM_DEFINITIONS,
);

export type CorePlaneQueryName = keyof typeof CORE_QUERY_DEFINITIONS;
export type WorkerPlaneQueryName = keyof typeof WORKER_QUERY_DEFINITIONS;
export type CanopyQueryName = keyof typeof CANOPY_QUERY_DEFINITIONS;
export type CanopyInstructionName = keyof typeof CANOPY_INSTRUCTION_DEFINITIONS;
export type RegisteredCanopyStreamName = keyof typeof CANOPY_STREAM_DEFINITIONS;

type DefinitionFor<Name extends CanopyQueryName> =
  (typeof CANOPY_QUERY_DEFINITIONS)[Name];

export type CanopyQueryParams<Name extends CanopyQueryName> = z.output<
  DefinitionFor<Name>['params']
>;

export type CanopyQueryResult<Name extends CanopyQueryName> = z.output<
  DefinitionFor<Name>['result']
>;

export type CanopyQueryHandler<
  Name extends CanopyQueryName,
  Context = unknown,
> = (
  params: CanopyQueryParams<Name>,
  context: Context,
) => CanopyQueryResult<Name> | Promise<CanopyQueryResult<Name>>;

export type CanopyQueryHandlerMap<Context = unknown> = {
  [Name in CanopyQueryName]: CanopyQueryHandler<Name, Context>;
};

export type CanopyQueryDefinitionRegistry = typeof CANOPY_QUERY_DEFINITIONS;

export type AnyCanopyQueryDefinition = CanopyQueryDefinition;
export type AnyCanopyInstructionDefinition = CanopyInstructionDefinition;
export type AnyCanopyStreamDefinition = CanopyStreamDefinition;
export type CanopyInstructionDefinitionRegistry =
  typeof CANOPY_INSTRUCTION_DEFINITIONS;
export type CanopyStreamDefinitionRegistry = typeof CANOPY_STREAM_DEFINITIONS;

type InstructionFor<Name extends CanopyInstructionName> =
  (typeof CANOPY_INSTRUCTION_DEFINITIONS)[Name];
export type CanopyInstructionParams<Name extends CanopyInstructionName> =
  z.output<InstructionFor<Name>['params']>;
export type CanopyInstructionParamsInput<Name extends CanopyInstructionName> =
  z.input<InstructionFor<Name>['params']>;
export type CanopyInstructionResult<Name extends CanopyInstructionName> =
  z.output<InstructionFor<Name>['result']>;
export type CanopyInstructionResultInput<Name extends CanopyInstructionName> =
  z.input<InstructionFor<Name>['result']>;
export type CanopyInstructionHandler<
  Name extends CanopyInstructionName,
  Context = unknown,
> = (
  params: CanopyInstructionParams<Name>,
  context: Context,
) =>
  | CanopyInstructionResultInput<Name>
  | Promise<CanopyInstructionResultInput<Name>>;
export type CanopyInstructionHandlerMap<Context = unknown> = {
  [Name in CanopyInstructionName]: CanopyInstructionHandler<Name, Context>;
};

type StreamFor<Name extends RegisteredCanopyStreamName> =
  (typeof CANOPY_STREAM_DEFINITIONS)[Name];
export type CanopyStreamParams<Name extends RegisteredCanopyStreamName> =
  z.output<StreamFor<Name>['params']>;
export type CanopyStreamParamsInput<Name extends RegisteredCanopyStreamName> =
  z.input<StreamFor<Name>['params']>;
export type CanopyStreamItem<Name extends RegisteredCanopyStreamName> =
  z.output<StreamFor<Name>['item']>;
export type CanopyStreamItemInput<Name extends RegisteredCanopyStreamName> =
  z.input<StreamFor<Name>['item']>;
export type CanopyStreamEnd<Name extends RegisteredCanopyStreamName> = z.output<
  StreamFor<Name>['end']
>;
export type CanopyStreamHandlerMap<Context = unknown> = {
  [Name in RegisteredCanopyStreamName]: (
    params: CanopyStreamParams<Name>,
    context: Context,
    sink: {
      /** Frames emitted but not yet taken by the consumer. */
      buffered?(): number;
      emit(
        item: CanopyStreamItemInput<Name>,
        onCursorAssigned?: (cursor: CanopyStreamCursor) => void,
      ): CanopyStreamCursor | null;
      end(
        outcome: 'completed' | 'cancelled' | 'error',
        error?: CanopyErrorPayload,
      ): void;
    },
  ) => Promise<(() => void) | void>;
};
