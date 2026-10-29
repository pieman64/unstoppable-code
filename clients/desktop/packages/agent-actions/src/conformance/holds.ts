import type {
  CanopyQueryParams,
  CanopyQueryResult,
} from '@canopy/protocol/canopy-core';
import type {
  AgentEnvironmentPort,
  AgentPortQueryName,
  AgentPostMessageReceipt,
  AgentStartChatReceipt,
} from '../port/environment-port';
import type { AgentActionCall } from '../surface/family';
import { AgentPortError } from '../port/environment-port';
import type {
  AgentConformanceHoldOutcome,
  AgentConformanceWriteHold,
} from './suite';

interface PendingHold {
  begin(): void;
  outcome: Promise<AgentConformanceHoldOutcome>;
}

function createHold(): {
  hold: AgentConformanceWriteHold;
  pending: PendingHold;
} {
  let begin: () => void = () => undefined;
  let finish: (outcome: AgentConformanceHoldOutcome) => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const outcome = new Promise<AgentConformanceHoldOutcome>((resolve) => {
    finish = resolve;
  });
  return { hold: { started, finish }, pending: { begin, outcome } };
}

/** Runs a held write as the test finishes it. */
async function runHeld<T>(
  pending: PendingHold | null,
  failure: string,
  write: () => Promise<T>,
): Promise<T> {
  if (!pending) return write();
  pending.begin();
  const outcome = await pending.outcome;
  if (outcome === 'fail') throw new Error(failure);
  const result = await write();
  if (outcome === 'timeout') {
    throw new AgentPortError(
      'timeout',
      'The write timed out; it may have happened.',
      true,
    );
  }
  return result;
}

/**
 * Conformance support for `control.holdNextChatStart` and
 * `control.holdNextMessagePost`: wraps an environment port so the next
 * `startChat` or `postMessage` waits until the test finishes it, and fails
 * it when the test says so.
 */
export function createWriteHolds(): {
  holdNextChatStart: () => AgentConformanceWriteHold;
  holdNextMessagePost: () => AgentConformanceWriteHold;
  wrap: <H>(port: AgentEnvironmentPort<H>) => AgentEnvironmentPort<H>;
} {
  let nextStart: PendingHold | null = null;
  let nextPost: PendingHold | null = null;
  return {
    holdNextChatStart: (): AgentConformanceWriteHold => {
      const { hold, pending } = createHold();
      nextStart = pending;
      return hold;
    },
    holdNextMessagePost: (): AgentConformanceWriteHold => {
      const { hold, pending } = createHold();
      nextPost = pending;
      return hold;
    },
    wrap: <H>(port: AgentEnvironmentPort<H>): AgentEnvironmentPort<H> => {
      // Every member is delegated explicitly, so prototype methods of a
      // class-based port keep their receiver, and a new port member is a type
      // error here until it is delegated.
      const wrapped: {
        [K in keyof AgentEnvironmentPort<H>]-?: unknown;
      } & AgentEnvironmentPort<H> = {
        query: <N extends AgentPortQueryName>(
          name: N,
          params: CanopyQueryParams<N>,
          call: AgentActionCall<H>,
        ): Promise<CanopyQueryResult<N>> => port.query(name, params, call),
        getChat: (input, call) => port.getChat(input, call),
        startChat: async (input, call): Promise<AgentStartChatReceipt> => {
          const pending = nextStart;
          nextStart = null;
          return runHeld(pending, 'The held chat start failed.', () =>
            port.startChat(input, call),
          );
        },
        postMessage: async (input, call): Promise<AgentPostMessageReceipt> => {
          const pending = nextPost;
          nextPost = null;
          return runHeld(pending, 'The held message post failed.', () =>
            port.postMessage(input, call),
          );
        },
        listModels: (input, call) => port.listModels(input, call),
        callerDepth: (call) => port.callerDepth(call),
        unmessageableChatIds: (input, call) =>
          port.unmessageableChatIds
            ? port.unmessageableChatIds(input, call)
            : Promise.resolve([]),
      };
      return wrapped;
    },
  };
}
