import { SkillUsageTracker } from '../agents/skill-usage-tracker';
import { SkillShareNudgeState } from '../agents/skill-share-nudge-state';
import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types/invocable-inventory';
const origin = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };
function entry(name: string, plugin?: string): InvocableInventoryEntry {
  return {
    id: name,
    provider: 'claude',
    kind: plugin ? 'plugin_skill' : 'skill',
    name,
    displayName: name,
    description: '',
    insertText: `/${name}`,
    invocationKey: `/${name}`,
    enableRef: plugin
      ? { kind: 'plugin', marketplaceId: 'm', pluginName: plugin }
      : { kind: 'skill', sourceId: 'custom:app', skillName: name },
  };
}
describe('skill usage per dequeued turn', () => {
  it('deduplicates typed/tool uses, plugin members, and retries of the same turn', () => {
    const state = new SkillShareNudgeState();
    const record = jest.spyOn(state, 'recordUse').mockResolvedValue(undefined);
    const sessionOptions = {
      ...origin,
      cwd: '/private/path',
      model: 'private-model',
    };
    const tracker = new SkillUsageTracker(sessionOptions, state);
    const first = tracker.startTurn('one', true);
    tracker.observeInvocation(first, '$first args', [entry('first', 'plugin')]);
    tracker.observeEntry(first, entry('first', 'plugin'));
    tracker.observeEntry(first, entry('second', 'plugin'));
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toEqual(origin);
    expect(tracker.startTurn('one', true)).toBe(first);
    tracker.observeEntry(first, entry('second', 'plugin'));
    const second = tracker.startTurn('two', true);
    tracker.observeEntry(second, entry('second', 'plugin'));
    expect(record).toHaveBeenCalledTimes(2);
    tracker.observeInvocation(second, 'prose /unknown', [entry('first')]);
    expect(record).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });
  it('resets eligibility for automation, rejects delayed observations and subagents/replays', () => {
    const state = new SkillShareNudgeState();
    const record = jest.spyOn(state, 'recordUse').mockResolvedValue(undefined);
    const tracker = new SkillUsageTracker(origin, state);
    const first = tracker.startTurn('user', true);
    expect(tracker.claimToolCall('subagent', true)).toBeUndefined();
    const captured = tracker.claimToolCall('call', false);
    expect(captured).toBe(first);
    const automation = tracker.startTurn('automation', false);
    tracker.observeEntry(captured, entry('first'));
    tracker.observeEntry(automation, entry('first'));
    expect(tracker.claimToolCall('call', false)).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
    const user = tracker.startTurn('user-two', true);
    tracker.observeEntry(user, entry('first'));
    tracker.endTurn();
    tracker.observeEntry(user, entry('second'));
    expect(record).toHaveBeenCalledTimes(1);
    tracker.dispose();
    tracker.observeEntry(user, entry('third'));
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('catches registry failures without rejecting the session observation', async () => {
    const state = new SkillShareNudgeState();
    jest
      .spyOn(state, 'recordUse')
      .mockRejectedValue(new Error('private details'));
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const tracker = new SkillUsageTracker(origin, state);
    tracker.observeEntry(tracker.startTurn('one', true), entry('secret'));
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith('Failed to persist local skill usage');
    tracker.dispose();
    log.mockRestore();
  });
});
