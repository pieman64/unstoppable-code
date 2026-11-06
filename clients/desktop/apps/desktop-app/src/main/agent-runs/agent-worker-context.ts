import { AsyncLocalStorage } from 'node:async_hooks';

export interface AgentWorkerContext {
  readonly kind: 'turn' | 'subagent';
  readonly runId: string;
}

const context = new AsyncLocalStorage<AgentWorkerContext>();

export class AgentOutsideWorkerError extends Error {
  constructor(entry: string) {
    super(
      `Chat sessions and subagents run through the local worker (${entry}).`,
    );
    this.name = 'AgentOutsideWorkerError';
  }
}

export function runInAgentWorker<T>(
  value: AgentWorkerContext,
  run: () => T | Promise<T>,
): Promise<T> {
  return context.run(value, () => Promise.resolve(run()));
}

export function runInAgentWorkerSync<T>(
  value: AgentWorkerContext,
  run: () => T,
): T {
  return context.run(value, run);
}

export function currentAgentWorkerContext(): AgentWorkerContext | undefined {
  return context.getStore();
}

export function assertAgentWorkerContext(entry: string): AgentWorkerContext {
  const value = currentAgentWorkerContext();
  if (!value) throw new AgentOutsideWorkerError(entry);
  return value;
}
