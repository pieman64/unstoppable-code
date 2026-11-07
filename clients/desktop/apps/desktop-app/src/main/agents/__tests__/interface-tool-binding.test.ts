import { InterfaceToolRegistry } from '@canopy/core-runtime/node/client';
import { interfaceToolDescriptor } from '@canopy/protocol/canopy-core';
import type { AgentSession, AgentSessionOptions } from '../types';
import {
  buildSessionKey,
  destroyAllSessions,
  getOrCreateSession,
  getSessionChangedOptions,
  registerSession,
} from '../session-manager';
import { runInAgentWorker } from '../../agent-runs/agent-worker-context';
import {
  resolveSessionInterfaceTools,
  setSessionInterfaceToolRegistry,
} from '../interface-tool-binding';

jest.mock('../claude-session', () => ({
  ClaudeCodeProvider: class {
    createSession = (opts: AgentSessionOptions): Partial<AgentSession> => {
      const session: Partial<AgentSession> = {
        isDisposed: (): boolean => false,
        destroy: (): Promise<void> => Promise.resolve(),
        setApprovalMode: (): Promise<void> => Promise.resolve(),
      };
      registerSession(
        buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId),
        session as AgentSession,
        new AbortController(),
        'claude',
        opts.model,
        opts.assistantMode,
      );
      return session;
    };
  },
}));

const options: AgentSessionOptions = {
  cwd: '/tmp/canopy-interface-tools',
  projectId: 'ws',
  worktreeId: 'wt',
  chatId: 'chat',
  planMode: false,
  providerType: 'claude',
  executionHarness: 'claude',
};

function mainWindowLease(): InterfaceToolRegistry {
  const registry = new InterfaceToolRegistry();
  registry.openLease(
    { leaseId: 'main-1', surface: 'main', interfaceKind: 'desktop' },
    { deliver: () => true, cancel: () => undefined },
  );
  registry.register('main-1', {
    tools: [interfaceToolDescriptor('ui.show_files')],
    _meta: { idempotencyKey: 'main-tools' },
  });
  setSessionInterfaceToolRegistry(registry);
  return registry;
}

afterEach(async () => {
  setSessionInterfaceToolRegistry(null);
  await destroyAllSessions();
});

describe('session interface tool binding (CAN-4131)', () => {
  it('resolveSessionInterfaceTools follows the registry', () => {
    expect(resolveSessionInterfaceTools({})).toEqual([]);
    const registry = mainWindowLease();
    expect(resolveSessionInterfaceTools({})).toEqual(['ui.show_files']);
    expect(
      resolveSessionInterfaceTools({ assistantMode: 'pipeline-editor' }),
    ).toEqual([]);
    expect(
      resolveSessionInterfaceTools({ assistantMode: 'app-advisor' }),
    ).toEqual(['ui.show_files']);
    registry.endLease('main-1');
    expect(resolveSessionInterfaceTools({})).toEqual([]);
  });

  it('a session bound with ShowFiles is replaced at the next turn after the lease ends', async () => {
    const registry = mainWindowLease();
    await runInAgentWorker({ kind: 'turn', runId: 'r' }, () =>
      getOrCreateSession(
        options,
        () => undefined,
        () => null,
      ),
    );
    await expect(getSessionChangedOptions(options)).resolves.not.toContain(
      'interfaceTools',
    );
    registry.endLease('main-1');
    await expect(getSessionChangedOptions(options)).resolves.toContain(
      'interfaceTools',
    );
  });
});
