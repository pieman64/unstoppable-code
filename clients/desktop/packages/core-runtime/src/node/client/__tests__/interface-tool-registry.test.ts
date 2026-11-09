import {
  interfaceToolDescriptor,
  type CoreClientToolDescriptor,
  type CoreClientToolsRegisterResult,
  type InterfaceSurface,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import {
  InterfaceToolRegistry,
  type InterfaceToolCall,
  type InterfaceToolCallPort,
  type InterfaceToolOutcome,
} from '../interface-tools';
import { CanopyOperationError } from '../../../runtime/errors';

const scope = { workspaceId: 'w1', worktreeId: 't1', chatId: 'c1' };

interface Harness {
  registry: InterfaceToolRegistry;
  advance: (ms: number) => void;
  errors: string[];
}
interface RecordingPort {
  port: InterfaceToolCallPort;
  delivered: InterfaceToolCall[];
  cancelled: string[];
}

function harness(): Harness {
  let clock = 1_000;
  let ids = 0;
  const timers: { at: number; callback: () => void; live: boolean }[] = [];
  const errors: string[] = [];
  const registry = new InterfaceToolRegistry({
    now: (): number => clock,
    setTimer: (callback, delayMs): { cancel(): void } => {
      const timer = { at: clock + delayMs, callback, live: true };
      timers.push(timer);
      return {
        cancel: (): void => {
          timer.live = false;
        },
      };
    },
    newCallId: (): string => `call-${++ids}`,
    onError: (_error, context): void => {
      errors.push(context);
    },
  });
  const advance = (ms: number): void => {
    clock += ms;
    for (const timer of timers)
      if (timer.live && timer.at <= clock) {
        timer.live = false;
        timer.callback();
      }
  };
  return { registry, advance, errors };
}

function recordingPort(accept = true): RecordingPort {
  const delivered: InterfaceToolCall[] = [];
  const cancelled: string[] = [];
  const port: InterfaceToolCallPort = {
    deliver: (call) => {
      delivered.push(call);
      return accept;
    },
    cancel: (callId) => {
      cancelled.push(callId);
    },
  };
  return { port, delivered, cancelled };
}

function open(
  registry: InterfaceToolRegistry,
  leaseId: string,
  surface: InterfaceSurface = 'main',
  port = recordingPort(),
): RecordingPort {
  registry.openLease({ leaseId, surface, interfaceKind: 'desktop' }, port.port);
  return port;
}

let keys = 0;
function register(
  registry: InterfaceToolRegistry,
  leaseId: string,
  tools: readonly (InterfaceToolName | CoreClientToolDescriptor)[],
  idempotencyKey = `key-${++keys}`,
): CoreClientToolsRegisterResult {
  return registry.register(leaseId, {
    tools: tools.map((tool) =>
      typeof tool === 'string' ? interfaceToolDescriptor(tool) : tool,
    ),
    _meta: { idempotencyKey },
  });
}

const call = (
  registry: InterfaceToolRegistry,
  signal?: AbortSignal,
): Promise<InterfaceToolOutcome> =>
  registry.invoke({
    toolName: 'ui.show_files',
    input: { payload: { files: [] } },
    scope,
    ...(signal ? { signal } : {}),
  });

const errorKind = (outcome: InterfaceToolOutcome): string =>
  outcome.ok ? 'ok' : outcome.error.kind;

function thrownPayload(
  action: () => unknown,
): { kind: string; code?: string } | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof CanopyOperationError ? error.payload : undefined;
  }
  throw new Error('expected a throw');
}

describe('InterfaceToolRegistry (CAN-4131)', () => {
  it("a registration outside the catalog or the surface's allowance is refused and changes nothing", async () => {
    const { registry } = harness();
    open(registry, 'main-lease');
    open(registry, 'advisor-lease', 'app-advisor');
    register(registry, 'main-lease', ['ui.get_current_ui_state']);
    const before = registry.available();
    const showFiles = interfaceToolDescriptor('ui.show_files');
    const attempts: [string, CoreClientToolDescriptor[]][] = [
      ['main-lease', [{ ...showFiles, name: 'ui.open_window' }]],
      ['main-lease', [{ ...showFiles, version: 2 }]],
      ['main-lease', [{ ...showFiles, category: 'native_intent' }]],
      ['advisor-lease', [showFiles]],
      ['main-lease', [showFiles, showFiles]],
    ];
    for (const [leaseId, tools] of attempts) {
      const payload = thrownPayload(() => register(registry, leaseId, tools));
      expect(payload?.kind).toBe('invalid_argument');
      expect(registry.available()).toBe(before);
    }
    expect(registry.available().toolNames).toEqual(['ui.get_current_ui_state']);
    const outcome = await call(registry);
    expect(errorKind(outcome)).toBe('capability_unavailable');
  });

  it('a reused key replays the first result or conflicts', () => {
    const { registry } = harness();
    open(registry, 'lease-a');
    const first = register(registry, 'lease-a', ['ui.show_files'], 'same');
    expect(register(registry, 'lease-a', ['ui.show_files'], 'same')).toBe(
      first,
    );
    const payload = thrownPayload(() =>
      register(registry, 'lease-a', ['ui.get_current_ui_state'], 'same'),
    );
    expect(payload).toMatchObject({
      kind: 'conflict',
      code: 'core.client.tools.revisionConflict',
    });
    expect(registry.available().toolNames).toEqual(['ui.show_files']);
    const missing = thrownPayload(() =>
      register(registry, 'no-lease', ['ui.show_files']),
    );
    expect(missing).toMatchObject({
      kind: 'not_found',
      code: 'core.client.tools.notFound',
    });
  });

  it("a call is delivered once, through the serving lease's port only", async () => {
    const { registry } = harness();
    const a = open(registry, 'lease-a');
    const b = open(registry, 'lease-b');
    register(registry, 'lease-a', ['ui.show_files']);
    register(registry, 'lease-b', ['ui.get_current_ui_state']);
    const pending = call(registry);
    expect(a.delivered).toHaveLength(1);
    expect(a.delivered[0]).toMatchObject({
      callId: 'call-1',
      toolName: 'ui.show_files',
      input: { payload: { files: [] } },
      deadlineAt: 31_000,
      scope,
    });
    expect(b.delivered).toHaveLength(0);
    expect(
      registry.reply('lease-a', 'call-1', { requestId: 'call-1', ok: true }),
    ).toBe('settled');
    await expect(pending).resolves.toEqual({
      ok: true,
      reply: { requestId: 'call-1', ok: true },
      servedBy: { leaseId: 'lease-a', surface: 'main' },
    });
  });

  it('with two eligible leases exactly one serves and the other sees nothing', async () => {
    const { registry } = harness();
    const a = open(registry, 'lease-a');
    const b = open(registry, 'lease-b');
    register(registry, 'lease-a', ['ui.show_files']);
    register(registry, 'lease-b', ['ui.show_files']);
    const pending = call(registry);
    expect(b.delivered).toHaveLength(1);
    expect(a.delivered).toHaveLength(0);
    registry.reply('lease-b', 'call-1', { ok: true });
    expect((await pending).ok).toBe(true);
    expect(a.delivered).toHaveLength(0);
  });

  it('a reply from another lease, a late reply and an unknown call id are refused', async () => {
    const { registry } = harness();
    open(registry, 'lease-a');
    open(registry, 'lease-b');
    register(registry, 'lease-a', ['ui.show_files']);
    let settled = false;
    const pending = call(registry).then((outcome) => {
      settled = true;
      return outcome;
    });
    expect(registry.reply('lease-b', 'call-1', { ok: true })).toBe(
      'wrong_lease',
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(registry.reply('lease-a', 'call-1', { ok: true })).toBe('settled');
    expect((await pending).ok).toBe(true);
    expect(registry.reply('lease-a', 'call-1', { ok: true })).toBe(
      'unknown_call',
    );
    expect(registry.reply('lease-a', 'never-made', { ok: true })).toBe(
      'unknown_call',
    );
  });

  it('ending a lease removes its tools and fails its in-flight calls', async () => {
    const { registry } = harness();
    const a = open(registry, 'lease-a');
    register(registry, 'lease-a', ['ui.show_files']);
    const changes: unknown[] = [];
    registry.onChange((availability) => changes.push(availability));
    const first = call(registry);
    const second = call(registry);
    expect(registry.endLease('lease-a')).toBe(1);
    for (const outcome of await Promise.all([first, second]))
      expect(outcome).toEqual({
        ok: false,
        error: {
          kind: 'capability_unavailable',
          message: 'The interface that served this tool disconnected.',
          retry: { kind: 'never' },
        },
      });
    expect(a.cancelled).toEqual(['call-1', 'call-2']);
    expect(registry.available().toolNames).toEqual([]);
    expect(changes).toHaveLength(1);
    expect(registry.hasLease('lease-a')).toBe(false);
    expect(registry.endLease('lease-a')).toBe(0);
    expect(registry.reply('lease-a', 'call-1', { ok: true })).toBe(
      'unknown_call',
    );
  });

  it('an invalid or oversized reply fails the call as internal', async () => {
    const { registry } = harness();
    open(registry, 'lease-a');
    register(registry, 'lease-a', ['ui.show_files']);
    const replies: unknown[] = [
      'text',
      [1, 2],
      null,
      { value: 'x'.repeat(1_048_577) },
    ];
    for (const reply of replies) {
      const pending = call(registry);
      const callId = `call-${replies.indexOf(reply) + 1}`;
      expect(registry.reply('lease-a', callId, reply)).toBe('invalid');
      expect(await pending).toEqual({
        ok: false,
        error: {
          kind: 'internal',
          message: 'The interface returned an invalid result.',
          retry: { kind: 'never' },
        },
      });
    }
  });

  it('payloads past 32 KiB within the declared limits are delivered and settled', async () => {
    const { registry } = harness();
    const a = open(registry, 'lease-a');
    register(registry, 'lease-a', ['ui.show_files']);
    const files = Array.from({ length: 2_000 }, (_, i) => `src/file-${i}.ts`);
    const pending = registry.invoke({
      toolName: 'ui.show_files',
      input: { payload: { files } },
      scope,
    });
    expect(a.delivered[0]?.input).toEqual({ payload: { files } });
    const reply = { requestId: 'call-1', ok: true, state: 'x'.repeat(500_000) };
    expect(registry.reply('lease-a', 'call-1', reply)).toBe('settled');
    await expect(pending).resolves.toMatchObject({ ok: true, reply });

    const tooLarge = await registry.invoke({
      toolName: 'ui.show_files',
      input: { payload: 'x'.repeat(262_145) },
      scope,
    });
    expect(errorKind(tooLarge)).toBe('invalid_argument');
    expect(a.delivered).toHaveLength(1);
  });

  it('the deadline fails the call and cancels it at the interface', async () => {
    const { registry, advance } = harness();
    const a = open(registry, 'lease-a');
    register(registry, 'lease-a', ['ui.show_files']);
    const pending = call(registry);
    advance(29_999);
    expect(a.cancelled).toEqual([]);
    advance(1);
    expect(errorKind(await pending)).toBe('deadline_exceeded');
    expect(a.cancelled).toEqual(['call-1']);
    expect(registry.reply('lease-a', 'call-1', { ok: true })).toBe(
      'unknown_call',
    );
  });

  it('an aborted signal cancels the call once', async () => {
    const { registry } = harness();
    const a = open(registry, 'lease-a');
    register(registry, 'lease-a', ['ui.show_files']);
    const controller = new AbortController();
    const pending = call(registry, controller.signal);
    controller.abort();
    controller.abort();
    expect(errorKind(await pending)).toBe('cancelled');
    expect(a.cancelled).toEqual(['call-1']);
    const early = await call(registry, controller.signal);
    expect(errorKind(early)).toBe('cancelled');
    expect(a.delivered).toHaveLength(1);
  });

  it('no serving lease fails without delivery, and a failed delivery tries no other lease', async () => {
    const { registry, errors } = harness();
    expect(errorKind(await call(registry))).toBe('capability_unavailable');
    const a = open(registry, 'lease-a');
    register(registry, 'lease-a', ['ui.show_files']);
    const refusing = open(registry, 'lease-b', 'main', recordingPort(false));
    register(registry, 'lease-b', ['ui.show_files']);
    expect(await call(registry)).toEqual({
      ok: false,
      error: {
        kind: 'capability_unavailable',
        message: 'The interface could not receive this tool call.',
        retry: { kind: 'never' },
      },
    });
    expect(refusing.delivered).toHaveLength(1);
    expect(refusing.cancelled).toEqual([]);
    expect(a.delivered).toHaveLength(0);
    const throwing: InterfaceToolCallPort = {
      deliver: () => {
        throw new Error('gone');
      },
      cancel: () => undefined,
    };
    registry.openLease(
      { leaseId: 'lease-c', surface: 'main', interfaceKind: 'desktop' },
      throwing,
    );
    register(registry, 'lease-c', ['ui.show_files']);
    expect(errorKind(await call(registry))).toBe('capability_unavailable');
    expect(errors).toContain('interface tool delivery');
    expect(a.delivered).toHaveLength(0);
  });

  it('availability changes once per change and hasLiveLease follows open leases', () => {
    const { registry, errors } = harness();
    const changes: (readonly string[])[] = [];
    registry.onChange((availability) => changes.push(availability.toolNames));
    registry.onChange(() => {
      throw new Error('listener');
    });
    expect(registry.hasLiveLease()).toBe(false);
    open(registry, 'lease-a');
    expect(registry.hasLiveLease()).toBe(true);
    expect(changes).toEqual([]);
    register(registry, 'lease-a', ['ui.show_files']);
    register(registry, 'lease-a', ['ui.show_files']);
    register(registry, 'lease-a', ['ui.show_files', 'ui.get_current_ui_state']);
    expect(
      registry.unregister('lease-a', { toolNames: ['ui.show_files'] }),
    ).toEqual({ registrationRevision: 4, removedToolNames: ['ui.show_files'] });
    expect(
      registry.unregister('lease-a', { toolNames: ['ui.show_files'] }),
    ).toEqual({ registrationRevision: 4, removedToolNames: [] });
    expect(registry.hasLease('lease-a')).toBe(true);
    registry.unregister('lease-a', { all: true });
    expect(changes).toEqual([
      ['ui.show_files'],
      ['ui.get_current_ui_state', 'ui.show_files'],
      ['ui.get_current_ui_state'],
      [],
    ]);
    expect(registry.available().revision).toBe(4);
    expect(registry.hasLiveLease()).toBe(true);
    registry.close();
    expect(registry.hasLiveLease()).toBe(false);
    expect(() => open(registry, 'lease-b')).toThrow(
      'Interface tool registry closed.',
    );
    expect(
      errors.filter((c) => c === 'interface tool availability listener'),
    ).toHaveLength(4);
  });

  it('a lease serves only calls of its own audience (CAN-5823)', async () => {
    const { registry } = harness();
    const local = open(registry, 'local');
    const remote = recordingPort();
    registry.openLease(
      {
        leaseId: 'remote',
        surface: 'main',
        interfaceKind: 'desktop',
        audience: 'controller-a',
      },
      remote.port,
    );
    register(registry, 'local', ['ui.show_files']);
    register(registry, 'remote', ['ui.show_files', 'ui.get_current_ui_state']);
    // A remote lease never counts as this computer's own windows.
    expect(registry.available().toolNames).toEqual(['ui.show_files']);
    expect(registry.availableFor('controller-a')).toEqual([
      'ui.get_current_ui_state',
      'ui.show_files',
    ]);
    expect(registry.availableFor('controller-b')).toEqual([]);
    const fromLocal = call(registry);
    const fromRemote = registry.invoke({
      toolName: 'ui.show_files',
      input: {},
      scope,
      audience: 'controller-a',
    });
    expect(local.delivered).toHaveLength(1);
    expect(remote.delivered).toHaveLength(1);
    expect(registry.reply('remote', local.delivered[0]?.callId ?? '', {})).toBe(
      'wrong_lease',
    );
    registry.reply('local', local.delivered[0]?.callId ?? '', {});
    registry.reply('remote', remote.delivered[0]?.callId ?? '', {});
    expect((await fromLocal).ok).toBe(true);
    expect((await fromRemote).ok).toBe(true);
    const otherController = await registry.invoke({
      toolName: 'ui.get_current_ui_state',
      input: {},
      scope,
      audience: 'controller-b',
    });
    expect(errorKind(otherController)).toBe('capability_unavailable');
    expect(
      errorKind(
        await registry.invoke({
          toolName: 'ui.get_current_ui_state',
          input: {},
          scope,
        }),
      ),
    ).toBe('capability_unavailable');
    registry.endLease('local');
    expect(registry.hasLiveLease()).toBe(false);
  });

  it('a settled call reports the lease that served it and nothing of its content (CAN-5828)', async () => {
    const settled: unknown[] = [];
    let clock = 5_000;
    let ids = 0;
    const registry = new InterfaceToolRegistry({
      now: (): number => clock,
      newCallId: (): string => `call-${++ids}`,
      onSettled: (event): void => {
        settled.push(event);
      },
    });
    // No serving lease: nothing answered, nothing recorded.
    expect(errorKind(await call(registry))).toBe('capability_unavailable');
    const port = recordingPort();
    registry.openLease(
      {
        leaseId: 'remote',
        surface: 'main',
        interfaceKind: 'desktop',
        audience: 'controller-a',
      },
      port.port,
    );
    register(registry, 'remote', ['ui.show_files']);
    const pending = registry.invoke({
      toolName: 'ui.show_files',
      input: { payload: { files: [{ path: 'secret-plan.md' }] } },
      scope,
      audience: 'controller-a',
    });
    clock += 250;
    registry.reply('remote', 'call-1', { ok: true, note: 'private reply' });
    expect((await pending).ok).toBe(true);
    const aborted = new AbortController();
    const cancelled = registry.invoke({
      toolName: 'ui.show_files',
      input: {},
      scope,
      audience: 'controller-a',
      signal: aborted.signal,
    });
    aborted.abort();
    expect(errorKind(await cancelled)).toBe('cancelled');
    expect(settled).toEqual([
      {
        toolName: 'ui.show_files',
        callId: 'call-1',
        leaseId: 'remote',
        surface: 'main',
        interfaceKind: 'desktop',
        audience: 'controller-a',
        scope,
        outcome: 'answered',
        deliveredAt: 5_000,
        settledAt: 5_250,
      },
      expect.objectContaining({ callId: 'call-2', outcome: 'cancelled' }),
    ]);
    expect(JSON.stringify(settled)).not.toMatch(/secret-plan|private reply/);
  });
});
