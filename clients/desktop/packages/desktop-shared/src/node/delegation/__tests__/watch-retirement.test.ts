import type { AgentDelegationResult } from '@canopy/protocol/delegation';
import { BRAND } from '@canopy/brand/current';
import { DelegationParent } from '../parent';
import { CANOPY_INJECTED_TOOL_ENTRIES } from '../../../lib/canopy-injected-tools';

const namespace = BRAND.tools.namespace;
const legacy = ['cano', 'py'].join('');
const expected = {
  ok: true,
  value: {
    watcherId: 'delegation-notices-automatic',
    mode: 'all',
    deadlineAt: 0,
    targets: [],
    message:
      'Delegate completion notices now arrive automatically; no watch is needed.',
  },
};
const input = { delegationIds: ['unknown'], mode: 'all', timeoutMs: 0 };
type BrokerSpies = Record<
  'spawn' | 'getOutput' | 'inspect' | 'list' | 'stop' | 'closeOwner' | 'watch',
  jest.Mock
>;
function setup(
  harness: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode',
): { parent: DelegationParent; broker: BrokerSpies } {
  const broker = {
    spawn: jest.fn(),
    getOutput: jest.fn(),
    inspect: jest.fn(),
    list: jest.fn(),
    stop: jest.fn(),
    closeOwner: jest.fn(),
    watch: jest.fn(),
  };
  const parent = new DelegationParent({
    harness,
    namespace,
    names: {
      spawn: 'Spawn',
      output: 'Output',
      inspect: 'Inspect',
      list: 'List',
      stop: 'Stop',
    },
    owner: {
      harnessId: harness,
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionKey: 'p/w/c',
      runtimeGeneration: 1,
      depth: 0,
    },
    broker,
    currentTurn: (): string => 'turn',
    removeQueued: (): Promise<void> => Promise.resolve(),
    reportError: (): void => {},
  });
  return { parent, broker };
}
describe('unlisted watch compatibility', () => {
  it('omits watch from the live registry', () => {
    expect(
      CANOPY_INJECTED_TOOL_ENTRIES.map((t) => t.canonicalKey),
    ).not.toContain('watch_delegates');
  });
  it.each(['claude', 'codex', 'cursor', 'copilot', 'opencode'] as const)(
    'answers exact old names without broker calls for %s',
    async (harness) => {
      const { parent, broker } = setup(harness);
      for (const name of [
        'WatchDelegates',
        ...[namespace, legacy].flatMap((ns) => [
          `mcp__${ns}__WatchDelegates`,
          `${ns}_watch_delegates`,
        ]),
      ]) {
        expect(parent.ownsTool(name)).toBe(false);
        const result =
          harness === 'claude'
            ? await (async (): Promise<AgentDelegationResult<unknown>> => {
                const bound = parent.bindClaude(name, input, name);
                return bound.ok
                  ? parent.invokeClaude(name, bound.value)
                  : bound;
              })()
            : harness === 'codex'
              ? await parent.invokeCodex(
                  name,
                  input,
                  { callId: name, turnId: 'turn', threadId: 'thread' },
                  'thread',
                  'turn',
                )
              : await parent.invokeCursor(name, input, {
                  callId: name,
                  turnId: 'turn',
                });
        expect(result).toEqual(expected);
      }
      Object.values(broker).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    },
  );
  it('keeps thread, turn, abort and detached-owner fences', async () => {
    const { parent } = setup('codex');
    const native = { callId: 'call', turnId: 'turn', threadId: 'thread' };
    for (const changed of [{ threadId: 'wrong' }, { turnId: 'wrong' }]) {
      expect(
        await parent.invokeCodex(
          `${namespace}_watch_delegates`,
          input,
          { ...native, ...changed },
          'thread',
          'turn',
        ),
      ).toMatchObject({ ok: false });
    }
    const controller = new AbortController();
    controller.abort();
    expect(
      await parent.invokeCodex(
        `${namespace}_watch_delegates`,
        input,
        { ...native, signal: controller.signal },
        'thread',
        'turn',
      ),
    ).toMatchObject({ ok: false });
    parent.detach();
    expect(
      await parent.invokeCodex(
        'WatchDelegates',
        input,
        native,
        'thread',
        'turn',
      ),
    ).toMatchObject({ ok: false });
  });
  it('does not accept suffix lookalikes or unknown namespaces', async () => {
    const { parent } = setup('cursor');
    for (const name of [
      'other_watch_delegates',
      'mcp__other__WatchDelegates',
      'WatchDelegatesExtra',
      `${namespace}_watch_delegates_extra`,
    ]) {
      expect(
        await parent.invokeCursor(name, input, {
          callId: 'call',
          turnId: 'turn',
        }),
      ).toMatchObject({ ok: false });
    }
  });
});
