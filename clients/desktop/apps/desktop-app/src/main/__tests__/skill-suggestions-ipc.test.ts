import type { IpcMainInvokeEvent } from 'electron';
import { SKILL_SUGGESTION_CHANNELS } from '@canopy/desktop-shared/lib/skill-suggestions';
import type { DesktopIpcCallerResolver } from '../ipc/file-tree';

const mockHandlers = new Map<
  string,
  (event: IpcMainInvokeEvent, value?: unknown) => unknown
>();
const mockSurfacing = {
  subscribe: jest.fn((): (() => void) => () => undefined),
  getPending: jest.fn(),
  list: jest.fn(),
  resolve: jest.fn(),
};

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../skill-suggestions', () => ({
  skillSuggestionSurfacing: mockSurfacing,
}));

import {
  registerSkillSuggestionHandlers,
  validateSkillSuggestionOrigin,
  validateSkillSuggestionResolveRequest,
} from '../ipc/skill-suggestions';

const origin = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };
const sender = {
  id: 7,
  once: jest.fn(),
  isDestroyed: (): boolean => false,
};
const event = { sender } as unknown as IpcMainInvokeEvent;
const trusted: DesktopIpcCallerResolver = jest.fn();

describe('skill suggestion IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHandlers.clear();
  });

  it('validates origins, ids, resolutions and the modal source', () => {
    expect(validateSkillSuggestionOrigin(origin)).toEqual(origin);
    for (const value of [
      null,
      {},
      { ...origin, chatId: '../chat' },
      { ...origin, projectId: 1 },
    ]) {
      expect(() => validateSkillSuggestionOrigin(value)).toThrow();
    }
    expect(
      validateSkillSuggestionResolveRequest({
        ...origin,
        source: 'banner',
        pendingId: 'pending',
        suggestionId: 'suggestion',
        resolution: 'shown',
        extra: 'dropped',
      }),
    ).toEqual({
      ...origin,
      source: 'banner',
      pendingId: 'pending',
      suggestionId: 'suggestion',
      resolution: 'shown',
    });
    expect(
      validateSkillSuggestionResolveRequest({
        source: 'suggestions_modal',
        suggestionId: 'suggestion',
        resolution: 'dismissed',
      }),
    ).toEqual({
      source: 'suggestions_modal',
      suggestionId: 'suggestion',
      resolution: 'dismissed',
    });
    for (const value of [
      {
        source: 'suggestions_modal',
        suggestionId: 'suggestion',
        resolution: 'shown',
      },
      { source: 'other', suggestionId: 'suggestion', resolution: 'dismissed' },
      {
        ...origin,
        source: 'banner',
        suggestionId: 'suggestion',
        resolution: 'shown',
      },
      {
        ...origin,
        source: 'banner',
        pendingId: 'p',
        suggestionId: '../x',
        resolution: 'shown',
      },
      {
        ...origin,
        source: 'banner',
        pendingId: 'p',
        suggestionId: 's',
        resolution: 'shared',
      },
    ]) {
      expect(() => validateSkillSuggestionResolveRequest(value)).toThrow();
    }
  });

  it('authorizes the sender before reading state', () => {
    const rejecting = jest.fn(() => {
      throw new Error('Untrusted sender');
    });
    const close = registerSkillSuggestionHandlers(rejecting);
    expect(() =>
      mockHandlers.get(SKILL_SUGGESTION_CHANNELS.getPending)?.(event, origin),
    ).toThrow('Untrusted');
    expect(mockSurfacing.getPending).not.toHaveBeenCalled();
    close();
  });

  it('serves pending, list and resolve through the surfacing state', async () => {
    mockSurfacing.getPending.mockReturnValue(null);
    mockSurfacing.list.mockResolvedValue([]);
    mockSurfacing.resolve.mockResolvedValue(true);
    const close = registerSkillSuggestionHandlers(trusted);
    expect(
      mockHandlers.get(SKILL_SUGGESTION_CHANNELS.getPending)?.(event, origin),
    ).toEqual({ success: true, data: null });
    expect(mockSurfacing.getPending).toHaveBeenCalledWith(origin, 7);
    await expect(
      mockHandlers.get(SKILL_SUGGESTION_CHANNELS.list)?.(event),
    ).resolves.toEqual({ success: true, data: [] });
    await expect(
      mockHandlers.get(SKILL_SUGGESTION_CHANNELS.resolve)?.(event, {
        source: 'suggestions_modal',
        suggestionId: 'suggestion',
        resolution: 'accepted',
      }),
    ).resolves.toEqual({ success: true, data: true });
    close();
  });

  it('reports a failed resolution write without content', async () => {
    mockSurfacing.resolve.mockRejectedValue(new Error('disk full'));
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    registerSkillSuggestionHandlers(trusted);
    await expect(
      mockHandlers.get(SKILL_SUGGESTION_CHANNELS.resolve)?.(event, {
        source: 'suggestions_modal',
        suggestionId: 'suggestion',
        resolution: 'dismissed',
      }),
    ).resolves.toEqual({
      success: false,
      error: 'Could not save skill suggestion state. Please retry.',
    });
    error.mockRestore();
  });
});
