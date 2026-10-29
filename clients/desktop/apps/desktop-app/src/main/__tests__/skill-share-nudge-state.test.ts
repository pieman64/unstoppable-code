import { SkillShareNudgeState } from '../agents/skill-share-nudge-state';
import {
  recordSkillUse,
  resolveSkillShareNudge,
} from '../lib/skill-usage-registry';
import type { ShareTarget } from '@canopy/desktop-shared/lib/skill-share-nudge';
jest.mock('../lib/skill-usage-registry', () => ({
  recordSkillUse: jest.fn(),
  resolveSkillShareNudge: jest.fn(),
}));
const origin = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };
const target: ShareTarget = {
  kind: 'skill',
  sourceId: 'custom:app',
  name: 'test',
};
const plugin: ShareTarget = {
  kind: 'plugin',
  marketplaceId: 'm',
  pluginName: 'p',
};
function requirePending(
  state: SkillShareNudgeState,
  senderId: number,
): NonNullable<ReturnType<SkillShareNudgeState['getPending']>> {
  const pending = state.getPending(origin, senderId);
  if (!pending) throw new Error('Expected a pending suggestion');
  return pending;
}
beforeEach(() => {
  jest
    .mocked(recordSkillUse)
    .mockReset()
    .mockResolvedValue({ shouldEvaluateNudge: true });
  jest.mocked(resolveSkillShareNudge).mockReset().mockResolvedValue(undefined);
});

describe('main-owned pending nudges', () => {
  it('suppresses other windows/chats once durably shown, retaining the displayed banner', async () => {
    const state = new SkillShareNudgeState();
    const changed = jest.fn();
    state.subscribe(changed);
    await state.recordUse(origin, target, () => true);
    const other = { ...origin, chatId: 'other' };
    await state.recordUse(other, target, () => true);
    const pending = requirePending(state, 1);
    await expect(
      state.resolve(
        { ...origin, pendingId: pending.id, target, resolution: 'shown' },
        1,
      ),
    ).resolves.toBe(true);
    expect(state.getPending(origin, 1)?.state).toBe('shown');
    expect(state.getPending(origin, 2)).toBeNull();
    expect(state.getPending(other, 2)).toBeNull();
    expect(changed).toHaveBeenCalledWith(other);
    await state.resolve(
      { ...origin, pendingId: pending.id, target, resolution: 'dismissed' },
      1,
    );
    expect(state.getPending(origin, 1)).toBeNull();
    expect(new SkillShareNudgeState().getPending(origin, 1)).toBeNull();
  });
  it('replaces the pending target without resolving the displaced identity and rejects stale resolutions', async () => {
    const state = new SkillShareNudgeState();
    await state.recordUse(origin, target, () => true);
    const pending = requirePending(state, 1);
    await state.recordUse(origin, plugin, () => true);
    await expect(
      state.resolve(
        { ...origin, pendingId: pending.id, target, resolution: 'shown' },
        1,
      ),
    ).resolves.toBe(false);
    expect(resolveSkillShareNudge).not.toHaveBeenCalled();
    expect(state.getPending(origin, 1)?.target).toEqual(plugin);
    const current = requirePending(state, 1);
    await expect(
      state.resolve(
        { ...origin, pendingId: current.id, target, resolution: 'shown' },
        1,
      ),
    ).resolves.toBe(false);
  });
  it('retains pending state on persistence failure so acknowledgement can be retried', async () => {
    const state = new SkillShareNudgeState();
    await state.recordUse(origin, target, () => true);
    const pending = requirePending(state, 1);
    jest
      .mocked(resolveSkillShareNudge)
      .mockRejectedValueOnce(new Error('disk'));
    const request = {
      ...origin,
      pendingId: pending.id,
      target,
      resolution: 'shown' as const,
    };
    await expect(state.resolve(request, 1)).rejects.toThrow('disk');
    expect(state.getPending(origin, 2)?.state).toBe('pending');
    await state.resolve(request, 1);
    expect(state.getPending(origin, 2)).toBeNull();
  });
  it('persists an observed use when disposal precedes the queued write', async () => {
    const state = new SkillShareNudgeState();
    let live = true;
    const pendingWrite = state.recordUse(origin, target, () => live);
    live = false;
    await pendingWrite;
    expect(recordSkillUse).toHaveBeenCalledTimes(1);
    expect(state.getPending(origin, 1)).toBeNull();
  });
  it('does not let old-session cleanup clear a newer session suggestion', async () => {
    const state = new SkillShareNudgeState();
    const oldSession = (): boolean => true;
    const newSession = (): boolean => true;
    await state.recordUse(origin, target, oldSession);
    await state.recordUse(origin, plugin, newSession);
    state.clear(origin, oldSession);
    expect(state.getPending(origin, 1)?.target).toEqual(plugin);
    state.clear(origin, newSession);
    expect(state.getPending(origin, 1)).toBeNull();
  });
  it('does not resurrect disposed sessions during asynchronous recording', async () => {
    const state = new SkillShareNudgeState();
    let live = true;
    jest.mocked(recordSkillUse).mockImplementationOnce(() => {
      live = false;
      return Promise.resolve({ shouldEvaluateNudge: true });
    });
    await state.recordUse(origin, target, () => live);
    expect(state.getPending(origin, 1)).toBeNull();
    await state.recordUse(origin, plugin, () => false);
    expect(recordSkillUse).toHaveBeenCalledTimes(2);
  });
});
