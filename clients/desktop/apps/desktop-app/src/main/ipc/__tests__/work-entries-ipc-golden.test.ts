import {
  IPC_CHANNELS,
  type CoworkWorkEntryDeleteRequest,
  type CoworkWorkEntryUpdateRequest,
} from '@canopy/desktop-shared/types';
import { registerWorkEntryHandlers } from '../../ipc/work-entries';

jest.mock('../../ipc/register', () => {
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  return {
    handlers,
    registerIpcHandler: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ): Map<string, (event: unknown, ...args: unknown[]) => unknown> =>
      handlers.set(channel, handler),
  };
});
jest.mock('../../lib/work-entry-mutations', () => ({
  assertWorkEntryWorkspace: (projectId: string): string => projectId,
  updateWorkEntryMutation: jest.fn(),
  deleteWorkEntryMutation: jest.fn(),
}));
jest.mock('../../agents/session-manager', () => ({
  getActiveChatIds: jest.fn(),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  createWorkEntry: jest.fn(),
  listWorkEntries: jest.fn(),
  onWorkEntryListChanged: jest.fn(() => jest.fn()),
  reorderWorkEntries: jest.fn(),
  resolveWorkEntryForChat: jest.fn(),
}));

const ipcRegistry = jest.requireMock<{
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
}>('../../ipc/register');
const mutations = jest.requireMock<{
  updateWorkEntryMutation: jest.Mock;
  deleteWorkEntryMutation: jest.Mock;
}>('../../lib/work-entry-mutations');

function handlerFor(
  channel: string,
): (event: unknown, ...args: unknown[]) => unknown {
  const handler = ipcRegistry.handlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return handler;
}

beforeEach(() => {
  jest.clearAllMocks();
  ipcRegistry.handlers.clear();
  mutations.updateWorkEntryMutation.mockResolvedValue(undefined);
  mutations.deleteWorkEntryMutation.mockResolvedValue({
    browserCleanupPending: true,
  });
});

test('IPC update delegates the original request and preserves void result', async () => {
  registerWorkEntryHandlers();
  const request: CoworkWorkEntryUpdateRequest = {
    projectId: 'project-a',
    entryId: 'entry-a',
    title: null,
  };

  const result = await handlerFor(IPC_CHANNELS.workEntriesUpdate)(
    undefined,
    request,
  );

  expect(mutations.updateWorkEntryMutation).toHaveBeenCalledWith(request);
  expect(result).toBeUndefined();
});

test('IPC delete delegates the original request and preserves response', async () => {
  registerWorkEntryHandlers();
  const request: CoworkWorkEntryDeleteRequest = {
    projectId: 'project-a',
    entryId: 'entry-a',
    lockAfterArchive: true,
  };
  const response = { browserCleanupPending: true };

  const result = await handlerFor(IPC_CHANNELS.workEntriesDelete)(
    undefined,
    request,
  );

  expect(mutations.deleteWorkEntryMutation).toHaveBeenCalledWith(request);
  expect(result).toEqual(response);
});
