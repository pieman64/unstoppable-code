import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import {
  baseTask,
  createBrokerHarness,
  rootParent,
  startOf,
  waitForLaunch,
} from './broker-harness';

describe('delegation record store classification', () => {
  it('classifies accessible stream records without projecting snapshots or indexes', async () => {
    const { broker, runner } = createBrokerHarness({
      testOnlyStreamGeneration: true,
      transcriptPort: new InMemoryDelegationTranscriptPort({
        owns: (): boolean => true,
        ownsChat: (): boolean => true,
      }),
    });
    await broker.initialize();
    try {
      const root = await broker.spawn(rootParent, {
        ...baseTask,
        allowNestedDelegation: true,
      });
      if (!root.ok) throw new Error('Expected a root delegation');
      await waitForLaunch(runner, root.value.delegationId);
      const childParent = broker.childContext(
        startOf(runner, root.value.delegationId),
        'nested-call',
      );
      if (!childParent) throw new Error('Expected a child parent context');
      const descendant = await broker.spawn(childParent, baseTask);
      if (!descendant.ok) throw new Error('Expected a descendant delegation');
      await waitForLaunch(runner, descendant.value.delegationId);

      const projectSpy = jest.fn();
      const indexSpy = jest.fn();
      Object.defineProperty(broker, 'projectLive', { value: projectSpy });
      Object.defineProperty(broker, 'project', { value: projectSpy });
      Object.defineProperty(broker, 'childIndex', { value: indexSpy });

      expect(broker.recordStore(rootParent, root.value.delegationId)).toBe(
        'stream',
      );
      expect(
        broker.recordStore(rootParent, descendant.value.delegationId),
      ).toBe('stream');
      expect(
        broker.recordStore(childParent, descendant.value.delegationId),
      ).toBe('stream');
      expect(
        broker.recordStore(
          { ...rootParent, chatId: 'unrelated-chat' },
          root.value.delegationId,
        ),
      ).toBeUndefined();
      expect(
        broker.recordStore(
          { ...rootParent, worktreeId: 'unrelated-worktree' },
          root.value.delegationId,
        ),
      ).toBeUndefined();
      expect(
        broker.recordStore(
          { ...rootParent, depth: 1, parentDelegationId: undefined },
          root.value.delegationId,
        ),
      ).toBeUndefined();
      expect(
        broker.recordStore(rootParent, 'unknown-delegation'),
      ).toBeUndefined();
      expect(projectSpy).not.toHaveBeenCalled();
      expect(indexSpy).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('classifies accessible non-v3 records as legacy', async () => {
    const { broker } = createBrokerHarness();
    await broker.initialize();
    try {
      const spawned = await broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error('Expected a delegation');
      expect(broker.recordStore(rootParent, spawned.value.delegationId)).toBe(
        'legacy',
      );
    } finally {
      await broker.close();
    }
  });
});
