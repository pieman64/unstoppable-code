import {
  notifyShareCompleted,
  requestShare,
  subscribeShareCompleted,
  useShareRequestStore,
} from '../shareRequestStore';

const SKILL = { kind: 'skill', sourceId: 'custom:app', name: 'notes' } as const;
const PLUGIN = {
  kind: 'plugin',
  marketplaceId: 'market',
  pluginName: 'tools',
} as const;

describe('shareRequestStore', () => {
  beforeEach(() => {
    useShareRequestStore.setState({ hostCount: 0, request: null });
  });

  it('accepts nothing while no host is mounted', () => {
    expect(requestShare(SKILL, { source: 'artifact_card' })).toBeNull();
    expect(useShareRequestStore.getState().request).toBeNull();
  });

  it('keeps one request and lets a newer one replace it', () => {
    const unregister = useShareRequestStore.getState().registerHost();
    const first = requestShare(SKILL, { source: 'mention_detail' });
    const second = requestShare(PLUGIN, {
      source: 'usage_nudge',
      origin: {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        pendingId: 'pending-1',
      },
    });
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(useShareRequestStore.getState().request).toMatchObject({
      id: second,
      target: PLUGIN,
      source: 'usage_nudge',
      origin: { pendingId: 'pending-1' },
    });
    unregister();
  });

  it('ignores a stale clear so it cannot drop the replacement', () => {
    const unregister = useShareRequestStore.getState().registerHost();
    const first = requestShare(SKILL, { source: 'agent' });
    const second = requestShare(PLUGIN, { source: 'agent' });
    if (!first || !second) throw new Error('requests must be accepted');
    useShareRequestStore.getState().clearRequest(first);
    expect(useShareRequestStore.getState().request?.id).toBe(second);
    useShareRequestStore.getState().clearRequest(second);
    expect(useShareRequestStore.getState().request).toBeNull();
    unregister();
  });

  it('drops the pending request when the last host unmounts', () => {
    const unregisterA = useShareRequestStore.getState().registerHost();
    const unregisterB = useShareRequestStore.getState().registerHost();
    requestShare(SKILL, { source: 'activity_panel' });
    unregisterA();
    unregisterA();
    expect(useShareRequestStore.getState().hostCount).toBe(1);
    expect(useShareRequestStore.getState().request).not.toBeNull();
    unregisterB();
    expect(useShareRequestStore.getState().hostCount).toBe(0);
    expect(useShareRequestStore.getState().request).toBeNull();
  });

  it('delivers completions only to current subscribers', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeShareCompleted(listener);
    const request = { id: 'share-x', target: SKILL, source: 'agent' } as const;
    notifyShareCompleted(request);
    unsubscribe();
    notifyShareCompleted(request);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(request);
  });
});
