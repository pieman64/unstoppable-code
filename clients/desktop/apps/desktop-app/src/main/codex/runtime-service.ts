import type { CodexRuntimeService } from '@canopy/desktop-shared/node/codex-runtime';
import {
  createCodexRuntimeService,
  resetCanonicalCodexHomeForTests,
} from '@canopy/desktop-shared/node/codex-runtime';
import './runtime-host-adapter';
import { getDesktopCodexCapabilityStore } from './capability-store';

let runtimeService: CodexRuntimeService | null = null;
let shutdownPromise: Promise<void> | null = null;
const replacementListeners = new Set<() => void>();

/**
 * Observe the shared runtime being shut down (and so replaced on next use).
 * Account-scoped caches built from the old runtime must not outlive it.
 */
export function onCodexRuntimeServiceReplaced(
  listener: () => void,
): () => void {
  replacementListeners.add(listener);
  return (): void => {
    replacementListeners.delete(listener);
  };
}

function notifyRuntimeServiceReplaced(): void {
  for (const listener of Array.from(replacementListeners)) {
    try {
      listener();
    } catch {
      // A cache observer must never block runtime shutdown.
    }
  }
}

export function getCodexRuntimeService(): CodexRuntimeService {
  if (!runtimeService) {
    runtimeService = createCodexRuntimeService({
      capabilityStore: getDesktopCodexCapabilityStore(),
    });
    shutdownPromise = null;
  }
  return runtimeService;
}

export function shutdownCodexRuntimeService(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  const service = runtimeService;
  runtimeService = null;
  shutdownPromise = service?.shutdown() ?? Promise.resolve();
  if (service) notifyRuntimeServiceReplaced();
  return shutdownPromise;
}

export async function resetCodexRuntimeServiceForTests(): Promise<void> {
  await shutdownCodexRuntimeService();
  resetCanonicalCodexHomeForTests();
  shutdownPromise = null;
}
