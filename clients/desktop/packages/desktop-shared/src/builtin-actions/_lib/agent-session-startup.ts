import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';

export const DEFAULT_AGENT_SESSION_START_TIMEOUT_MS = 10 * 60_000;

type AgentSessionMode = 'start' | 'resume';

export class AgentSessionStartupTimeoutError extends Error {}

function getAgentSessionStartTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = getBrandEnv(env, 'AGENT_SESSION_START_TIMEOUT_MS');
  if (!raw) {
    return DEFAULT_AGENT_SESSION_START_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_AGENT_SESSION_START_TIMEOUT_MS;
}

function startupTimeoutMessage(
  actionLabel: string,
  mode: AgentSessionMode,
  timeoutMs: number,
): string {
  const operation = mode === 'resume' ? 'resume' : 'start';
  return `${actionLabel}: agent session did not ${operation} within ${String(timeoutMs)} ms`;
}

export async function* withAgentSessionStartupTimeout<T>(
  stream: AsyncIterable<T>,
  options: {
    actionLabel: string;
    env: NodeJS.ProcessEnv;
    mode: AgentSessionMode;
    onTimeout: () => void;
  },
): AsyncGenerator<T, void> {
  const timeoutMs = getAgentSessionStartTimeoutMs(options.env);
  if (timeoutMs === 0) {
    yield* stream;
    return;
  }

  const iterator = stream[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        options.onTimeout();
      } finally {
        reject(
          new AgentSessionStartupTimeoutError(
            startupTimeoutMessage(options.actionLabel, options.mode, timeoutMs),
          ),
        );
      }
    }, timeoutMs);
  });

  try {
    const first = await Promise.race([iterator.next(), timeout]);
    if (first.done) {
      return;
    }

    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    yield first.value;

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (!timedOut) {
      await iterator.return?.();
    }
  }
}

export function withClaudeSessionStartupTimeout(
  query: Query,
  env: NodeJS.ProcessEnv,
  actionLabel: string,
  mode: AgentSessionMode = 'start',
): AsyncGenerator<SDKMessage, void> {
  return withAgentSessionStartupTimeout(query, {
    actionLabel,
    env,
    mode,
    onTimeout: () => query.close(),
  });
}
