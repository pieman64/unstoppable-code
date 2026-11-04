import { totalmem } from 'node:os';
import { getResolvedGitExecutableForSpawn } from '../lib/git-executable';
import { getExecutionHostPort } from '../execution-host/utility-process-host';
import { codeGraphHostBudget } from '@canopy/code-graph/host/budgets';
import type { CodeGraphRepositoryInput } from '@canopy/desktop-shared/types/code-graph';
import type { CodeGraphFingerprintWorkerResponse } from '@canopy/code-graph/host/fingerprint-host';
import {
  createCodeGraphFingerprintScheduler,
  type CodeGraphFingerprintOptions,
} from '@canopy/code-graph/host/fingerprint-scheduler';
import { getCodeGraphGenerationTimeoutMs } from '../lib/code-graph-availability';
import {
  leaveBackgroundProcessPolicy,
  lowerSpawnedProcessPriority,
} from '../lib/background-process';

// The fingerprint host queue lives in `@canopy/code-graph/host`. This module
// composes it for Electron main: utility-process fingerprint hosts with the
// Git the app resolved, and the generation timeout preference.

export type {
  CodeGraphFingerprintWorkerRequest,
  CodeGraphFingerprintWorkerResponse,
} from '@canopy/code-graph/host/fingerprint-host';
export {
  CodeGraphFingerprintWorkerError,
  type CodeGraphFingerprintOptions,
  type CodeGraphFingerprintWorkerErrorReason,
} from '@canopy/code-graph/host/fingerprint-scheduler';

const WORKER_ENTRY_FILENAME = 'code-graph-fingerprint-worker.js';
const WORKER_SERVICE_NAME = 'code-graph-fingerprint';

const scheduler = createCodeGraphFingerprintScheduler({
  resolveGitExecutable: () => getResolvedGitExecutableForSpawn(),
  launchFingerprintHost: (gitExecutable) =>
    getExecutionHostPort().launch({
      entry: WORKER_ENTRY_FILENAME,
      serviceName: WORKER_SERVICE_NAME,
      budget: codeGraphHostBudget('fingerprint', {
        totalMemoryBytes: totalmem(),
      }),
      env: { CANOPY_GIT_EXECUTABLE: gitExecutable },
    }),
  applyProcessPriority: (pid, options) =>
    lowerSpawnedProcessPriority(pid, options),
  leaveBackgroundPolicy: (pid) => leaveBackgroundProcessPolicy(pid),
  timeoutMs: () => getCodeGraphGenerationTimeoutMs(),
});

export function runCodeGraphWorkerFingerprint(
  key: string,
  repositories: readonly CodeGraphRepositoryInput[],
  options: CodeGraphFingerprintOptions = {},
): Promise<CodeGraphFingerprintWorkerResponse> {
  return scheduler.run(key, repositories, options);
}

export function cancelCodeGraphFingerprint(key: string): Promise<void> {
  return scheduler.cancel(key);
}

export function shutdownCodeGraphFingerprintWorkers(): Promise<void> {
  return scheduler.shutdown();
}

export function resetCodeGraphFingerprintRunnerForTests(): void {
  scheduler.reset();
}
