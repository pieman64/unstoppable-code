/*
 * Compatibility names for the worker-owned Codex runtime (CAN-4117). The
 * runtime lives in agent-runs/codex-worker-runtime.ts; callers and test mocks
 * keep importing this module.
 */
export {
  codexRuntimeForWorkerRun,
  CodexRuntimeOutsideWorkerError,
  type CodexWorkerRunEntry,
  acquireCodexWorkerRuntime as getCodexRuntimeService,
  onCodexWorkerRuntimeReplaced as onCodexRuntimeServiceReplaced,
  resetCodexWorkerRuntimeForTests as resetCodexRuntimeServiceForTests,
  shutdownCodexWorkerRuntime as shutdownCodexRuntimeService,
} from '../agent-runs/codex-worker-runtime';
