import {
  CanopyCallerDescriptorSchema,
  type CanopyCallerDescriptor,
  type CanopyInstructionDefinitionMap,
  type CanopyQueryDefinitionMap,
  type CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';
import type {
  CanopyDispatcher,
  CanopyDispatcherInstructionName,
  CanopyDispatcherInstructionParamsInput,
  CanopyDispatcherInstructionResult,
  CanopyDispatcherQueryName,
  CanopyDispatcherQueryParams,
  CanopyDispatcherQueryResult,
  CanopyDispatcherStreamName,
  CanopyDispatcherStreamParamsInput,
  CanopyDispatcherStreamItem,
  CanopyDispatcherStreamEnd,
  CanopyStreamFrame,
  CanopyStreamHandle,
  InProcessCanopyClient,
  InProcessCanopyInstructionOptions,
  InProcessCanopyQueryOptions,
  InProcessCanopyStreamOptions,
} from './types';

export function createInProcessCanopyClient<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap = Record<never, never>,
  S extends CanopyStreamDefinitionMap = Record<never, never>,
>(
  dispatcher: CanopyDispatcher<Q, I, S>,
  callerInput: CanopyCallerDescriptor,
): InProcessCanopyClient<Q, I, S> {
  const parsedCaller = CanopyCallerDescriptorSchema.parse(callerInput);
  const caller: CanopyCallerDescriptor = {
    ...parsedCaller,
    grants: [...parsedCaller.grants],
  };
  Object.freeze(caller.grants);
  Object.freeze(caller);
  return {
    query<N extends CanopyDispatcherQueryName<Q>>(
      name: N,
      params: CanopyDispatcherQueryParams<Q, N>,
      options: InProcessCanopyQueryOptions = {},
    ): Promise<CanopyDispatcherQueryResult<Q, N>> {
      return dispatcher.query(name, params, { ...options, caller });
    },
    instruction<N extends CanopyDispatcherInstructionName<I>>(
      name: N,
      params: CanopyDispatcherInstructionParamsInput<I, N>,
      options: InProcessCanopyInstructionOptions = {},
    ): Promise<CanopyDispatcherInstructionResult<I, N>> {
      return dispatcher.instruction(name, params, { ...options, caller });
    },
    openStream<N extends CanopyDispatcherStreamName<S>>(
      name: N,
      params: CanopyDispatcherStreamParamsInput<S, N>,
      options: InProcessCanopyStreamOptions<
        CanopyStreamFrame<
          CanopyDispatcherStreamItem<S, N>,
          CanopyDispatcherStreamEnd<S, N>
        >
      > = {},
    ): Promise<
      CanopyStreamHandle<
        CanopyDispatcherStreamItem<S, N>,
        CanopyDispatcherStreamEnd<S, N>
      >
    > {
      return dispatcher.openStream(name, params, { ...options, caller });
    },
  };
}
