// CAN-5061 golden callers: thin drivers for the desktop IPC handlers, Portal
// commands and agent actions, so every golden reaches pipelines through the
// same entry point a real caller uses.
import { EventEmitter } from 'node:events';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import type { WorktreeActionRuntime } from '../../canopy-tools/worktree-actions';
import { GOLDEN_WORKSPACE_ID, GOLDEN_WORKTREE_ID } from './world';

export type GoldenIpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const goldenIpcHandlers = new Map<string, GoldenIpcHandler>();

/** Called by the test's `jest.mock('../../ipc/register')` factory. */
export function registerGoldenIpcHandler(
  channel: string,
  handler: GoldenIpcHandler,
): void {
  goldenIpcHandlers.set(channel, handler);
}

export function invokeIpc(
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = goldenIpcHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return Promise.resolve(handler({ sender: { id: 1 } }, ...args));
}

let commandSequence = 0;
let toolUseSequence = 0;

/**
 * Run one Portal command through `handlePortalCommand` and resolve with its
 * terminal `portal.command.completed` or `portal.command.failed` payload,
 * including completions an adapter finishes off the command loop.
 */
export async function runPortalCommand(
  type: string,
  payload: unknown,
  target: { workspaceLocalId?: string; worktreeLocalId?: string } = {
    workspaceLocalId: GOLDEN_WORKSPACE_ID,
    worktreeLocalId: GOLDEN_WORKTREE_ID,
  },
): Promise<{ event: string; payload: unknown; updates: unknown[] }> {
  const { handlePortalCommand } =
    await import('../../portal/portal-command-handlers');
  commandSequence += 1;
  const commandId = `golden-command-${commandSequence}`;
  const updates: unknown[] = [];
  return new Promise((resolvePromise, reject) => {
    const command = {
      type,
      commandId,
      sequenceNumber: commandSequence,
      payload,
      target,
      issuedAt: '2026-10-27T00:00:00.000Z',
    } as unknown as PortalCommandEnvelope;
    handlePortalCommand(command, {
      pairingCode: null,
      getWindow: () => null,
      markAuthenticated: () => undefined,
      stop: () => Promise.resolve(),
      enqueueEvent: (event) => {
        const record = event as unknown as {
          type: string;
          payload: unknown;
        };
        if (
          record.type === 'portal.command.completed' ||
          record.type === 'portal.command.failed'
        ) {
          resolvePromise({
            event: record.type,
            payload: record.payload,
            updates,
          });
        } else {
          updates.push({ type: record.type, payload: record.payload });
        }
      },
    }).catch(reject);
  });
}

export function goldenWorktreeActionRuntime(
  worktreePath: string,
  overrides: Partial<WorktreeActionRuntime> = {},
): WorktreeActionRuntime {
  return {
    projectId: GOLDEN_WORKSPACE_ID,
    worktreeId: GOLDEN_WORKTREE_ID,
    chatId: 'golden-chat',
    cwd: worktreePath,
    getWindow: () => null,
    ...overrides,
  };
}

/**
 * Run one `DispatchAction` call through the desktop agent action surface and
 * return the parsed tool result.
 */
export async function dispatchAgentAction(
  action: Record<string, unknown>,
  worktreeRuntime: WorktreeActionRuntime,
): Promise<unknown> {
  const { executeDesktopAgentActionTool } =
    await import('../../agent-actions/desktop-surface');
  const runtime = {
    requestUserAnswers: () => Promise.resolve([]),
    loadScriptOutput: () => Promise.reject(new Error('unused')),
    worktreeActionRuntime: worktreeRuntime,
  } as unknown as CanopyInjectedToolRuntime;
  const result = await executeDesktopAgentActionTool(
    'dispatch_action',
    { action },
    runtime,
    { toolUseId: `golden-tool-${(toolUseSequence += 1)}` },
  );
  try {
    const parsed: unknown = JSON.parse(result.text);
    return { isError: result.isError ?? false, result: parsed };
  } catch {
    return { isError: result.isError ?? false, text: result.text };
  }
}

/**
 * Electron's `utilityProcess.fork`, served in process: the real pipeline
 * process host worker runs over a message channel, so steps spawn real
 * child processes exactly as the desktop host does.
 */
export function forkGoldenUtilityProcess(): EventEmitter {
  const child = new EventEmitter();
  const parentPort = new EventEmitter();
  let exited = false;
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    setImmediate(() => child.emit('exit', code));
  };
  Object.assign(child, {
    pid: process.pid,
    postMessage: (message: unknown): void => {
      setImmediate(() => parentPort.emit('message', { data: message }));
    },
    kill: (): boolean => {
      exit(0);
      return true;
    },
  });
  Object.assign(parentPort, {
    postMessage: (message: unknown): void => {
      setImmediate(() => child.emit('message', message));
    },
  });
  void import('../../pipelines/process-host-worker').then(
    ({ startPipelineProcessHost }) =>
      startPipelineProcessHost(
        parentPort as unknown as Parameters<typeof startPipelineProcessHost>[0],
        exit,
      ),
  );
  return child;
}
