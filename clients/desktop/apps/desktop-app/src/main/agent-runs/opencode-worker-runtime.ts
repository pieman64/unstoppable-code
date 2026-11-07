import type { AgentProvider } from '../agents/types';
import type {
  OpenCodeExecutionRuntime,
  openOpenCodeExecutionRuntime,
} from '../opencode/execution-runtime';
import { randomUUID } from 'node:crypto';
import type {
  ProviderProcessRequest,
  ProviderProcessSpawner,
} from '@canopy/desktop-shared/node/provider-process/spawn';
import {
  assertAgentWorkerContext,
  currentAgentWorkerContext,
} from './agent-worker-context';
import { spawnProviderProcess } from './provider-process-host';
import type { WorkerProviderRuntime } from './worker-provider-runtimes';

/** The worker-owned OpenCode harness runtime (CAN-4120). */
export interface OpenCodeWorkerRuntime extends WorkerProviderRuntime {
  readonly harness: 'opencode';
}

async function providerFor(): Promise<AgentProvider> {
  assertAgentWorkerContext('OpenCodeWorkerRuntime.providerFor');
  const { OpenCodeProvider } = await import('../agents/opencode-session');
  return new OpenCodeProvider();
}

const runtime: OpenCodeWorkerRuntime = { harness: 'opencode', providerFor };

export function getOpenCodeWorkerRuntime(): OpenCodeWorkerRuntime {
  return runtime;
}

/** The OpenCode turns that must run inside a worker run. */
export type OpenCodeWorkerRunEntry =
  | 'opencodeSessionTurn'
  | 'opencodeDelegationRunner';

export type OpenCodeExecutionRuntimeInput = Parameters<
  typeof openOpenCodeExecutionRuntime
>[0];

/**
 * Opens the credential-bearing OpenCode execution runtime (inference lease,
 * environment, provider config) for a session or delegated turn. Refuses,
 * before anything is opened, unless the caller runs inside a worker turn or
 * subagent run (CAN-4120).
 */
export async function openOpenCodeExecutionForWorkerRun(
  entry: OpenCodeWorkerRunEntry,
  input: OpenCodeExecutionRuntimeInput,
): Promise<OpenCodeExecutionRuntime> {
  assertAgentWorkerContext(`OpenCodeWorkerRuntime.openExecution:${entry}`);
  // Loaded lazily: opencode/connection depends on this module (CAN-4120 PR2),
  // so a static value import would close a cycle.
  const { openOpenCodeExecutionRuntime } =
    await import('../opencode/execution-runtime');
  return openOpenCodeExecutionRuntime(input);
}

export type OpenCodeProcessOwner = ProviderProcessRequest['owner'];

export class OpenCodeProcessOutsideRunError extends Error {
  constructor(owner: OpenCodeProcessOwner) {
    super(
      `OpenCode processes for a ${owner.kind} start only inside that run (${owner.id}).`,
    );
    this.name = 'OpenCodeProcessOutsideRunError';
  }
}

/** The owner of the processes one managed runtime starts (CAN-4120 D7). */
export function openCodeProcessOwner(
  executionKind: 'agent' | 'pipeline' | undefined,
): OpenCodeProcessOwner {
  const context = currentAgentWorkerContext();
  if (context) return { kind: context.kind, id: context.runId };
  return {
    kind: executionKind === 'pipeline' ? 'pipeline' : 'discovery',
    id: randomUUID(),
  };
}

/**
 * The only OpenCode process spawner on desktop: a turn's or subagent's
 * process starts only inside that run; then the provider process host.
 */
export const spawnOpenCodeProcessForWorkerRun: ProviderProcessSpawner = (
  request,
) => {
  const { owner } = request;
  if (owner.kind === 'turn' || owner.kind === 'subagent') {
    const context = currentAgentWorkerContext();
    if (context?.kind !== owner.kind || context.runId !== owner.id)
      throw new OpenCodeProcessOutsideRunError(owner);
  }
  return spawnProviderProcess(request);
};
