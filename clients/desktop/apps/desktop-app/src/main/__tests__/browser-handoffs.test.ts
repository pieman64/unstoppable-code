import { BrowserHandoffStore } from '../browser/browser-handoffs';
import type { BrowserHandoff } from '@canopy/desktop-shared/types';

const origin = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatTabId: 'chat',
};
const request = {
  projectId: 'project',
  worktreeId: 'worktree',
  browserId: 'browser',
  runtimeGeneration: 1,
  origin,
};

describe('main-owned browser handoffs', () => {
  it('is idempotent across turns and hydration without publishing focus again', () => {
    const store = new BrowserHandoffStore();
    const publish = jest.fn();
    const first = store.request(request, publish);
    expect(store.request(request, publish)).toEqual(first);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.snapshot('project', 'worktree')).toEqual({
      revision: 1,
      handoff: first,
    });
    expect(store.snapshot('other', 'worktree').handoff).toBeNull();
    expect(
      new BrowserHandoffStore().snapshot('project', 'worktree').handoff,
    ).toBeNull();
  });

  it('invalidates in-flight handoffs after target or origin removal, even before a pin exists', () => {
    const store = new BrowserHandoffStore();
    const admission = store.captureAdmission('project', 'worktree', origin);
    store.releaseWorktree('unrelated', 'worktree');
    expect(
      store.isAdmissionCurrent('project', 'worktree', origin, admission),
    ).toBe(true);
    store.releaseOrigin(origin);
    expect(
      store.isAdmissionCurrent('project', 'worktree', origin, admission),
    ).toBe(false);
    const next = store.captureAdmission('project', 'worktree', origin);
    store.releaseWorktree('project', 'worktree');
    expect(store.isAdmissionCurrent('project', 'worktree', origin, next)).toBe(
      false,
    );
  });

  it('replaces a handoff and fences late release from an accepted send', () => {
    const store = new BrowserHandoffStore();
    const publish = jest.fn();
    const first = store.request(request, publish);
    const captured = store.captureOrigin(origin);
    const replacement = store.request(
      { ...request, browserId: 'other-browser' },
      publish,
    );
    for (const id of captured) store.release(id);
    expect(store.snapshot('project', 'worktree').handoff?.handoffId).toBe(
      replacement.handoffId,
    );
    expect(store.captureOrigin({ ...origin, chatTabId: 'other-chat' })).toEqual(
      [],
    );
    store.release(replacement.handoffId);
    expect(store.snapshot('project', 'worktree')).toEqual({
      revision: 3,
      handoff: null,
    });
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'handoff-released',
        handoffId: replacement.handoffId,
      }),
    );
    expect(first.handoffId).not.toBe(replacement.handoffId);
  });

  it.each(['browser', 'origin', 'worktree', 'chat'] as const)(
    'releases on %s removal',
    (removal) => {
      const store = new BrowserHandoffStore();
      store.request(
        {
          ...request,
          origin: { ...origin, projectId: 'advisor', worktreeId: 'entry' },
        },
        jest.fn(),
      );
      if (removal === 'browser') store.releaseBrowser('browser');
      if (removal === 'origin')
        store.releaseOrigin({
          ...origin,
          projectId: 'advisor',
          worktreeId: 'entry',
        });
      if (removal === 'worktree') store.releaseWorktree('advisor', 'entry');
      if (removal === 'chat') store.releaseChat('chat');
      expect(store.snapshot('project', 'worktree').handoff).toBeNull();
    },
  );

  it('does not expose mutable authority through request or hydration results', () => {
    const store = new BrowserHandoffStore();
    const result = store.request(request, jest.fn());
    result.origin.chatTabId = 'changed';
    const snapshot = store.snapshot('project', 'worktree');
    if (snapshot.handoff) snapshot.handoff.browserId = 'changed';
    const current: BrowserHandoff | null = store.snapshot(
      'project',
      'worktree',
    ).handoff;
    expect(current).toMatchObject({ browserId: 'browser', origin });
  });
});
