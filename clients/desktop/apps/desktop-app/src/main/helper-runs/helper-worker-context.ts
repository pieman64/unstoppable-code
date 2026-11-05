import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkerAgentHelperKind } from '@canopy/protocol/canopy-core';

export interface HelperWorkerContext {
  readonly helperRunId: string;
  readonly kind: WorkerAgentHelperKind;
}

const context = new AsyncLocalStorage<HelperWorkerContext>();

export class HelperOutsideWorkerError extends Error {
  constructor(entry: string) {
    super(`Helper model calls run through the local worker (${entry}).`);
    this.name = 'HelperOutsideWorkerError';
  }
}

export function runInHelperWorker<T>(
  value: HelperWorkerContext,
  run: () => Promise<T>,
): Promise<T> {
  return context.run(value, run);
}

export function currentHelperWorkerContext(): HelperWorkerContext | undefined {
  return context.getStore();
}

export function assertHelperWorkerContext(entry: string): HelperWorkerContext {
  const value = currentHelperWorkerContext();
  if (!value) throw new HelperOutsideWorkerError(entry);
  return value;
}
