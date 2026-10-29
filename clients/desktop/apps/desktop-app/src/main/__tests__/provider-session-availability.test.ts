import {
  ProviderMcpSession,
  getProviderMcpSession,
  invalidateMcpCredentialEvidence,
} from '../mcp/provider-session-availability';
import { McpActivationHandoff } from '../mcp/activation-handoff';
import { refreshClaudeMcpAvailability } from '../mcp/claude-session-availability';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

const scope = {
  projectId: 'provider-mcp-test',
  worktreeId: 'tree',
  chatId: 'chat',
};
const identity = {
  kind: 'standalone' as const,
  serverId: 'calendar',
  configId: 'work',
};
const tools = {
  kind: 'tools' as const,
  initialized: true as const,
  complete: true as const,
  toolCount: 1,
};

afterEach(() => getProviderMcpSession(scope)?.dispose());

it.each([
  ['failure', 'permission'],
  ['failure', 'ownership'],
  ['disposal', 'permission'],
  ['disposal', 'ownership'],
])(
  'prevents prompt submission after %s during the %s check',
  async (cause, boundary) => {
    let release: (value: boolean) => void = () => {};
    let checking: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      checking = resolve;
    });
    const canSend = jest.fn(() => {
      checking();
      return boundary === 'ownership'
        ? new Promise<boolean>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(true);
    });
    const handoff = new McpActivationHandoff(
      1000,
      'user',
      new AbortController().signal,
      canSend,
    );
    const session = new ProviderMcpSession(scope, 'claude', handoff);
    session.configure({ calendar: [identity] });
    const admission = handoff.dispatch();
    const prompt = handoff.beforePrompt('user');
    if (boundary === 'ownership') await entered;
    if (cause === 'disposal') session.dispose();
    else handoff.failed();
    release(true);
    await expect(prompt).rejects.toThrow('task changed');
    await expect(admission).resolves.toBe('not_sent');
    handoff.accepted();
    await expect(handoff.admission).resolves.toBe('not_sent');
  },
);

it('revokes Claude tool readiness while the SDK reconnects', async () => {
  const session = new ProviderMcpSession(scope, 'claude');
  session.configure({ calendar: [identity] });
  const query: Pick<Query, 'mcpServerStatus'> = {
    mcpServerStatus: jest
      .fn()
      .mockResolvedValueOnce([
        {
          name: 'calendar',
          status: 'connected',
          tools: [{ name: 'list_events' }],
        },
      ])
      .mockResolvedValueOnce([{ name: 'calendar', status: 'pending' }])
      .mockResolvedValueOnce([
        {
          name: 'calendar',
          status: 'connected',
          tools: [{ name: 'list_events' }],
        },
      ]),
  };
  await refreshClaudeMcpAvailability(query, session);
  expect(session.snapshot()[0].availability).toBe('ready');
  await refreshClaudeMcpAvailability(query, session);
  expect(session.snapshot()[0].availability).toBe('connecting');
  await refreshClaudeMcpAvailability(query, session);
  expect(session.snapshot()[0].availability).toBe('ready');
});

it('projects a runtime context to a stable serializable activation scope', () => {
  const context = { ...scope, onMessage: jest.fn() };
  const session = new ProviderMcpSession(context, 'claude');
  expect(() => session.configure({ calendar: [identity] })).not.toThrow();
  context.chatId = 'another-chat';
  expect(session.binding?.scope).toEqual(scope);
  session.observe(required(session.binding), 'calendar', tools);
  expect(session.snapshot()[0].availability).toBe('ready');
});

it('removal revokes ready evidence and late provider callbacks cannot restore it', () => {
  const session = new ProviderMcpSession(scope, 'claude');
  session.configure({ calendar: [identity] });
  const binding = required(session.binding);
  session.observe(binding, 'calendar', tools);
  session.revokeMissingSelections(new Set());
  session.observe(binding, 'calendar', tools);
  expect(session.snapshot()[0]).toMatchObject({
    selected: false,
    availability: 'not_selected',
    reasonCode: 'removed',
  });
});

it('waits for the captured native segment, releases on Stop, and ignores a replaced owner', async () => {
  const old = new ProviderMcpSession(scope, 'claude');
  const boundary = old.completedSegments;
  const stopped = new AbortController();
  const waiting = old.waitForSegmentAfter(boundary, stopped.signal);
  stopped.abort(new Error('Stopped'));
  await expect(waiting).rejects.toThrow('Stopped');
  old.segmentSettled();
  await expect(
    old.waitForSegmentAfter(boundary, new AbortController().signal),
  ).resolves.toBeUndefined();
  const replacement = new ProviderMcpSession(scope, 'claude');
  await expect(
    old.waitForSegmentAfter(
      old.completedSegments,
      new AbortController().signal,
    ),
  ).rejects.toThrow('changed');
  expect(replacement.completedSegments).toBe(0);
});

it('reserves a fresh generation on the turn after an activation is admitted', async () => {
  const handoff = new McpActivationHandoff(
    1000,
    'user',
    new AbortController().signal,
  );
  const session = new ProviderMcpSession(scope, 'codex', handoff);
  session.configure({ calendar: [identity] });
  const activated = required(session.binding);
  const admission = handoff.dispatch();
  await handoff.beforePrompt('user');
  handoff.accepted();
  await expect(admission).resolves.toBe('accepted');
  expect(() => session.configure({ calendar: [identity] })).not.toThrow();
  expect(session.binding?.generation).not.toBe(activated.generation);
  session.observe(activated, 'calendar', tools);
  expect(session.snapshot()[0].availability).toBe('connecting');
});

it('revokes ready evidence as soon as a replacement connection starts', () => {
  const session = new ProviderMcpSession(scope, 'cursor');
  session.configure({ calendar: [identity] });
  const old = session.observeConnection('calendar');
  session.observe(required(session.binding), 'calendar', tools);
  expect(session.snapshot()[0].availability).toBe('ready');
  session.observeConnection('calendar');
  expect(session.snapshot()[0].availability).not.toBe('ready');
  old.close();
  expect(session.snapshot()[0].availability).toBe('connecting');
});

it('invalidates old owners and generations without clearing a replacement', () => {
  const old = new ProviderMcpSession(scope, 'claude');
  old.configure({ calendar: [identity] });
  const first = required(old.binding);
  old.observe(first, 'calendar', tools);
  expect(old.snapshot()[0].availability).toBe('ready');
  old.configure({ calendar: [identity] });
  old.observe(first, 'calendar', tools);
  expect(old.snapshot()[0].availability).toBe('connecting');
  const current = new ProviderMcpSession(scope, 'codex');
  current.configure({ calendar: [identity] });
  old.configure({ calendar: [identity] });
  old.dispose();
  expect(getProviderMcpSession(scope)).toBe(current);
  expect(current.snapshot()[0].availability).toBe('connecting');
});

it('attributes one owning connection to its standalone, plugin and account selectors', () => {
  const session = new ProviderMcpSession(scope, 'codex');
  session.configure({
    calendar: [
      identity,
      {
        kind: 'plugin',
        marketplaceId: 'market',
        pluginName: 'calendar',
        serverName: 'calendar',
      },
      { kind: 'account', connectionId: 'account', configId: 'work' },
    ],
  });
  session.observe(required(session.binding), 'calendar', tools);
  expect(session.snapshot()).toHaveLength(3);
  expect(
    session.snapshot().every((status) => status.availability === 'ready'),
  ).toBe(true);
  session.dispose();
  expect(session.snapshot()).toEqual([]);
});

it('does not accept an unrelated or disabled server and preserves empty-tool evidence', () => {
  const session = new ProviderMcpSession(scope, 'claude');
  session.configure({ calendar: [identity] }, new Set(['calendar']));
  session.observe(required(session.binding), 'calendar', tools);
  expect(session.snapshot()[0].availability).toBe('disabled');
  session.configure({ calendar: [identity] });
  session.observe(required(session.binding), 'unrelated', tools);
  expect(session.snapshot()[0].availability).toBe('connecting');
  session.observe(required(session.binding), 'calendar', {
    ...tools,
    toolCount: 0,
  });
  expect(session.snapshot()[0]).toMatchObject({
    availability: 'unavailable',
    reasonCode: 'no_tools',
  });
});

it('invalidates the exact credential owner and rejects old ready callbacks', () => {
  const session = new ProviderMcpSession(scope, 'claude');
  session.configure({ calendar: [identity] }, undefined, {
    calendar: { serverId: 'calendar', configId: 'work' },
  });
  const binding = required(session.binding);
  session.observe(binding, 'calendar', tools);
  invalidateMcpCredentialEvidence(['unrelated']);
  expect(session.snapshot()[0].availability).toBe('ready');
  invalidateMcpCredentialEvidence(['calendar']);
  expect(session.binding?.generation).toBeGreaterThan(binding.generation);
  session.observe(binding, 'calendar', tools);
  expect(session.snapshot()[0].availability).not.toBe('ready');
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected fixture value');
  return value;
}
