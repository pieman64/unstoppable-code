import type { CursorProviderProcess } from '@canopy/desktop-shared/node/cursor/runtime-process';
import type { AgentProvider } from '../agents/types';
import { assertAgentWorkerContext } from './agent-worker-context';
import { spawnProviderProcess } from './provider-process-host';
import type { WorkerProviderRuntime } from './worker-provider-runtimes';

/** The worker-owned Cursor runtime (CAN-4118): the only constructor of CursorProvider. */
export interface CursorWorkerRuntime extends WorkerProviderRuntime {
  readonly harness: 'cursor';
}

class DesktopCursorWorkerRuntime implements CursorWorkerRuntime {
  readonly harness = 'cursor' as const;

  async providerFor(): Promise<AgentProvider> {
    assertAgentWorkerContext('CursorWorkerRuntime.providerFor');
    // Defer the ACP SDK and Cursor process/hook runtime until Cursor is used.
    // The packaged Electron main smoke exercises this lazy resolution path.
    const { CursorProvider } = await import('../agents/cursor-session');
    return new CursorProvider();
  }
}

const runtime = new DesktopCursorWorkerRuntime();

export function getCursorWorkerRuntime(): CursorWorkerRuntime {
  return runtime;
}

/**
 * The spawner and owner for a Cursor child started by the current worker run.
 * Throws AgentOutsideWorkerError outside a turn or subagent run.
 */
export function cursorProcessForWorkerRun(
  entry: string,
): CursorProviderProcess {
  const context = assertAgentWorkerContext(entry);
  return {
    spawner: spawnProviderProcess,
    owner: { kind: context.kind, id: context.runId },
  };
}
