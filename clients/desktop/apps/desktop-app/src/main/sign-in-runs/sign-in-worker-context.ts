import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkerAgentSignInProvider } from '@canopy/protocol/canopy-core';

export interface SignInWorkerContext {
  readonly signInRunId: string;
  readonly provider: WorkerAgentSignInProvider;
}

const context = new AsyncLocalStorage<SignInWorkerContext>();

export class SignInOutsideWorkerError extends Error {
  constructor(entry: string) {
    super(`Provider sign-in runs through the local worker (${entry}).`);
    this.name = 'SignInOutsideWorkerError';
  }
}

export function runInSignInWorker<T>(
  value: SignInWorkerContext,
  run: () => Promise<T>,
): Promise<T> {
  return context.run(value, run);
}

export function currentSignInWorkerContext(): SignInWorkerContext | undefined {
  return context.getStore();
}

export function assertSignInWorkerContext(entry: string): SignInWorkerContext {
  const value = currentSignInWorkerContext();
  if (!value) throw new SignInOutsideWorkerError(entry);
  return value;
}
