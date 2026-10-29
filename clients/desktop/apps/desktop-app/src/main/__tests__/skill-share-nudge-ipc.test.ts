import type { IpcMainInvokeEvent } from 'electron';
import type { DesktopIpcCallerResolver } from '../ipc/file-tree';
import { SKILL_SHARE_NUDGE_CHANNELS } from '@canopy/desktop-shared/lib/skill-share-nudge';
const mockHandlers = new Map<
  string,
  (event: IpcMainInvokeEvent, value: unknown) => unknown
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: IpcMainInvokeEvent, value: unknown) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
import {
  registerSkillShareNudgeHandlers,
  validateSkillShareNudgeOrigin,
  validateSkillShareNudgeResolution,
} from '../ipc/skill-share-nudge';
import { skillShareNudgeState } from '../agents/skill-share-nudge-state';
const origin = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };
describe('skill share nudge IPC', () => {
  it('rejects malformed origins, arbitrary keys, targets, and resolutions', () => {
    expect(validateSkillShareNudgeOrigin(origin)).toEqual(origin);
    for (const value of [
      null,
      {},
      { ...origin, chatId: '../chat' },
      { ...origin, projectId: 1 },
    ])
      expect(() => validateSkillShareNudgeOrigin(value)).toThrow();
    for (const value of [
      { ...origin, key: 'arbitrary' },
      {
        ...origin,
        pendingId: 'id',
        target: { kind: 'skill', name: 'test' },
        resolution: 'shown',
      },
      {
        ...origin,
        pendingId: 'id',
        target: { kind: 'plugin', marketplaceId: 'm', pluginName: 'p' },
        resolution: 'reset',
      },
    ])
      expect(() => validateSkillShareNudgeResolution(value)).toThrow();
  });
  it('authorizes senders before reading pending state or accepting resolutions', () => {
    const resolver = jest.fn<
      ReturnType<DesktopIpcCallerResolver>,
      Parameters<DesktopIpcCallerResolver>
    >(() => {
      throw new Error('Untrusted sender');
    });
    const close = registerSkillShareNudgeHandlers(resolver);
    const get = jest.spyOn(skillShareNudgeState, 'getPending');
    // The rejection happens before the handler can touch sender properties.
    expect(() =>
      mockHandlers.get(SKILL_SHARE_NUDGE_CHANNELS.getPending)?.(
        {} as IpcMainInvokeEvent,
        origin,
      ),
    ).toThrow('Untrusted');
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
    close();
  });
});
