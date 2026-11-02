import { DELEGATION_NOT_DESCENDANT_ERROR } from '@canopy/protocol/delegation';
import type { AgentDelegationBroker } from '../broker';
import { createDelegationProjection } from '../projections';
import type { DelegationParentContext } from '../types';
import {
  baseTask,
  createBrokerHarness,
  emit,
  flushBroker,
  rootParent,
  startOf,
  type BrokerHarness,
} from './broker-harness';

/**
 * root ─┬─ A (1) ─┬─ B (2) ── C (3) ── D (4)
 *       │         └─ B2 (2)
 *       └─ S (1)
 */
interface Tree {
  readonly a: string;
  readonly s: string;
  readonly b: string;
  readonly b2: string;
  readonly c: string;
  readonly d: string;
  readonly ctxA: DelegationParentContext;
  readonly ctxB: DelegationParentContext;
  readonly ctxC: DelegationParentContext;
}

async function spawnId(
  broker: AgentDelegationBroker,
  caller: DelegationParentContext,
  description: string,
  allowNestedDelegation = false,
): Promise<string> {
  const result = await broker.spawn(caller, {
    ...baseTask,
    description,
    ...(allowNestedDelegation ? { allowNestedDelegation } : {}),
  });
  if (!result.ok) throw new Error(`Expected ${description} to be admitted`);
  return result.value.delegationId;
}

function contextOf(
  harness: BrokerHarness,
  id: string,
  toolCallId: string,
): DelegationParentContext {
  const context = harness.broker.childContext(
    startOf(harness.runner, id),
    toolCallId,
  );
  if (!context) throw new Error(`Expected a caller context for ${id}`);
  return context;
}

async function buildTree(harness: BrokerHarness): Promise<Tree> {
  const { broker } = harness;
  const a = await spawnId(broker, rootParent, 'Depth one A', true);
  const s = await spawnId(
    broker,
    { ...rootParent, toolCallId: 'call-s' },
    'Depth one S',
  );
  await flushBroker();
  const ctxA = contextOf(harness, a, 'a-1');
  const b = await spawnId(broker, ctxA, 'Depth two B', true);
  const b2 = await spawnId(
    broker,
    { ...ctxA, toolCallId: 'a-2' },
    'Depth two B2',
  );
  await flushBroker();
  const ctxB = contextOf(harness, b, 'b-1');
  const c = await spawnId(broker, ctxB, 'Depth three C', true);
  await flushBroker();
  const ctxC = contextOf(harness, c, 'c-1');
  const d = await spawnId(broker, ctxC, 'Depth four D');
  await flushBroker();
  return { a, s, b, b2, c, d, ctxA, ctxB, ctxC };
}

const otherChat: DelegationParentContext = {
  ...rootParent,
  chatId: 'other-chat',
  sessionKey: 'project/worktree/other-chat',
};

describe('delegation access is scoped to the caller’s descendants', () => {
  it('allows every descendant and denies sibling, parent, grandparent, self and other chats at each depth', async () => {
    const harness = createBrokerHarness();
    const { broker } = harness;
    await broker.initialize();
    try {
      const tree = await buildTree(harness);
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly caller: DelegationParentContext;
        readonly allowed: readonly string[];
        readonly denied: readonly string[];
      }> = [
        {
          name: 'depth 0 root',
          caller: rootParent,
          allowed: [tree.a, tree.s, tree.b, tree.b2, tree.c, tree.d],
          denied: [],
        },
        {
          name: 'depth 1 A',
          caller: tree.ctxA,
          allowed: [tree.b, tree.b2, tree.c, tree.d],
          // sibling, self
          denied: [tree.s, tree.a],
        },
        {
          name: 'depth 2 B',
          caller: tree.ctxB,
          allowed: [tree.c, tree.d],
          // sibling, self, parent, parent's sibling
          denied: [tree.b2, tree.b, tree.a, tree.s],
        },
        {
          name: 'depth 3 C',
          caller: tree.ctxC,
          allowed: [tree.d],
          // self, parent, grandparent, grandparent's other child
          denied: [tree.c, tree.b, tree.a, tree.b2],
        },
      ];
      for (const { name, caller, allowed, denied } of cases) {
        for (const id of allowed) {
          expect([name, broker.inspect(caller, id)?.delegationId]).toEqual([
            name,
            id,
          ]);
          expect([
            name,
            await broker.getOutput(caller, { delegationId: id }),
          ]).toEqual([name, expect.objectContaining({ ok: true })]);
        }
        for (const id of denied) {
          expect([name, broker.inspect(caller, id)]).toEqual([name, undefined]);
          expect([
            name,
            await broker.getOutput(caller, { delegationId: id }),
          ]).toEqual([
            name,
            { ok: false, error: DELEGATION_NOT_DESCENDANT_ERROR },
          ]);
        }
        expect(
          broker
            .list(caller)
            .map((snapshot) => snapshot.delegationId)
            .sort(),
        ).toEqual([...allowed].sort());
      }
      // Another chat sees nothing, even from the root.
      expect(broker.inspect(otherChat, tree.a)).toBeUndefined();
      expect(broker.list(otherChat)).toEqual([]);
      expect(
        await broker.getOutput(otherChat, { delegationId: tree.a }),
      ).toEqual({
        ok: false,
        error: DELEGATION_NOT_DESCENDANT_ERROR,
      });
      expect(
        broker.inspect({ ...tree.ctxA, chatId: 'other-chat' }, tree.b),
      ).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it('keeps access to descendants after an intermediate ancestor’s run ends', async () => {
    const harness = createBrokerHarness();
    const { broker, runner } = harness;
    await broker.initialize();
    try {
      const tree = await buildTree(harness);
      await emit(runner, tree.a, 100, {
        type: 'terminal',
        status: 'completed',
        finalText: 'A finished.',
      });
      await emit(runner, tree.b, 100, {
        type: 'terminal',
        status: 'completed',
        finalText: 'B finished.',
      });
      await flushBroker();
      expect(broker.inspect(rootParent, tree.a)?.status).toBe('completed');
      expect(broker.inspect(rootParent, tree.b)?.status).toBe('completed');
      // C's parent and grandparent have ended; C still sees its child.
      expect(broker.inspect(tree.ctxC, tree.d)?.delegationId).toBe(tree.d);
      expect(broker.list(tree.ctxC).map((entry) => entry.delegationId)).toEqual(
        [tree.d],
      );
      // B's run ended, and its retained context still reaches its subtree.
      expect(broker.inspect(tree.ctxB, tree.d)?.delegationId).toBe(tree.d);
      // The root keeps the whole tree.
      expect(broker.inspect(rootParent, tree.d)?.delegationId).toBe(tree.d);
      await emit(runner, tree.d, 100, {
        type: 'terminal',
        status: 'completed',
        finalText: 'D finished.',
      });
      await flushBroker();
      expect(
        await broker.getOutput(tree.ctxC, { delegationId: tree.d }),
      ).toMatchObject({
        ok: true,
        value: { result: { status: 'completed', finalText: 'D finished.' } },
      });
    } finally {
      await broker.close();
    }
  });
});

describe('Get Delegate Output reaches every descendant', () => {
  it('reads grandchildren and deeper descendants', async () => {
    const harness = createBrokerHarness();
    const { broker, runner } = harness;
    await broker.initialize();
    try {
      const tree = await buildTree(harness);
      await emit(runner, tree.d, 100, {
        type: 'terminal',
        status: 'completed',
        finalText: 'Deep result.',
      });
      await flushBroker();
      expect(
        await broker.getOutput(tree.ctxA, { delegationId: tree.d }),
      ).toMatchObject({
        ok: true,
        value: { result: { finalText: 'Deep result.' } },
      });
    } finally {
      await broker.close();
    }
  });
});

describe('one denial for a delegation outside the caller’s subtree', () => {
  it('returns the same error from Inspect, Get Delegate Output, Stop, Message and List', async () => {
    const harness = createBrokerHarness();
    const { broker, runner } = harness;
    await broker.initialize();
    try {
      const tree = await buildTree(harness);
      const projection = createDelegationProjection('claude', 'test', broker);
      const calls: ReadonlyArray<readonly [string, unknown]> = [
        ['test_inspect_delegate', { delegationId: tree.b2 }],
        ['test_get_delegate_output', { delegationId: tree.b2 }],
        ['test_stop_delegate', { delegationId: tree.b2 }],
        [
          'test_message_delegate',
          { delegationId: tree.b2, operation: 'interrupt' },
        ],
        [
          'test_message_delegate',
          { delegationId: tree.b2, operation: 'steer', message: 'Stop now.' },
        ],
        ['test_list_delegates', { underDelegationId: tree.b2 }],
        ['test_list_delegates', { underDelegationId: tree.a }],
      ];
      let index = 0;
      for (const [name, input] of calls) {
        index += 1;
        expect([
          name,
          await projection.invoke(
            // Each tool call has its own identity, as in a real turn.
            { ...tree.ctxB, toolCallId: `deny-${index}` },
            name,
            input,
          ),
        ]).toEqual([
          name,
          { ok: false, error: DELEGATION_NOT_DESCENDANT_ERROR },
        ]);
      }
      expect(runner.stopped).not.toContain(tree.b2);
      expect(broker.inspect(rootParent, tree.b2)?.status).toBe('pending');
      // Unknown IDs are denied the same way by Inspect.
      await expect(
        projection.invoke(rootParent, 'test_inspect_delegate', {
          delegationId: 'not-a-delegation',
        }),
      ).resolves.toEqual({ ok: false, error: DELEGATION_NOT_DESCENDANT_ERROR });
      // A malformed request is still a malformed request.
      await expect(
        projection.invoke(tree.ctxB, 'test_inspect_delegate', {
          delegationId: tree.c,
          extra: true,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
      await expect(
        projection.invoke(tree.ctxB, 'test_list_delegates', {
          underDelegationId: 7,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    } finally {
      await broker.close();
    }
  });
});

describe('walking the delegation tree', () => {
  it('reports direct children on Inspect and List entries', async () => {
    const harness = createBrokerHarness();
    const { broker } = harness;
    await broker.initialize();
    try {
      const tree = await buildTree(harness);
      expect(broker.inspect(rootParent, tree.a)?.childDelegationIds).toEqual([
        tree.b,
        tree.b2,
      ]);
      expect(broker.inspect(tree.ctxA, tree.b)?.childDelegationIds).toEqual([
        tree.c,
      ]);
      expect(broker.inspect(rootParent, tree.d)).not.toHaveProperty(
        'childDelegationIds',
      );
      expect(broker.inspect(rootParent, tree.s)).not.toHaveProperty(
        'childDelegationIds',
      );
      const listed = broker.list(rootParent);
      expect(
        listed.find((entry) => entry.delegationId === tree.a)
          ?.childDelegationIds,
      ).toEqual([tree.b, tree.b2]);
      expect(
        listed.find((entry) => entry.delegationId === tree.c)
          ?.childDelegationIds,
      ).toEqual([tree.d]);
    } finally {
      await broker.close();
    }
  });

  it('keeps the 64 most recent direct children', async () => {
    const harness = createBrokerHarness({ capacity: 2 });
    const { broker } = harness;
    await broker.initialize();
    try {
      const a = await spawnId(broker, rootParent, 'Wide parent', true);
      await flushBroker();
      const ctxA = contextOf(harness, a, 'a-0');
      const children: string[] = [];
      for (let index = 0; index < 66; index++)
        children.push(
          await spawnId(
            broker,
            { ...ctxA, toolCallId: `a-${index + 1}` },
            `Child ${index}`,
          ),
        );
      const reported = broker.inspect(rootParent, a)?.childDelegationIds;
      expect(reported).toHaveLength(64);
      expect(reported).toEqual(children.slice(-64));
    } finally {
      await broker.close();
    }
  });

  it('lists only one delegation’s descendants with underDelegationId', async () => {
    const harness = createBrokerHarness();
    const { broker } = harness;
    await broker.initialize();
    try {
      const tree = await buildTree(harness);
      const ids = (
        caller: DelegationParentContext,
        underDelegationId: string,
      ): string[] =>
        broker
          .list(caller, { underDelegationId })
          .map((entry) => entry.delegationId)
          .sort();
      expect(ids(rootParent, tree.a)).toEqual(
        [tree.b, tree.b2, tree.c, tree.d].sort(),
      );
      expect(ids(rootParent, tree.s)).toEqual([]);
      expect(ids(tree.ctxA, tree.b)).toEqual([tree.c, tree.d].sort());
      // Never widens access: a sibling's subtree stays invisible.
      expect(ids(tree.ctxB, tree.a)).toEqual([tree.c, tree.d].sort());

      const projection = createDelegationProjection('claude', 'test', broker, {
        discoverModels: () => Promise.resolve({ models: [], truncated: false }),
      });
      // A caller may walk its own subtree by its own ID.
      await expect(
        projection.invoke(tree.ctxB, 'test_list_delegates', {
          underDelegationId: tree.b,
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: [{ delegationId: tree.c }, { delegationId: tree.d }],
      });
      await expect(
        projection.invoke(rootParent, 'test_list_delegates', {
          underDelegationId: tree.b,
          includeModels: true,
        }),
      ).resolves.toEqual({
        ok: true,
        value: {
          delegations: broker.list(rootParent, { underDelegationId: tree.b }),
          models: [],
          truncated: false,
        },
      });
      await expect(
        projection.invoke(rootParent, 'test_list_delegates', {
          underDelegationId: 'not-a-delegation',
        }),
      ).resolves.toEqual({ ok: false, error: DELEGATION_NOT_DESCENDANT_ERROR });
      await expect(
        projection.invoke(rootParent, 'test_list_delegates', {}),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await broker.close();
    }
  });
});
