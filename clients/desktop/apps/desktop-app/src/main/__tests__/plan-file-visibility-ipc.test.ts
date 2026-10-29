import { EventEmitter } from 'node:events';

const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));

jest.mock('../lib/tracked-plan-scope', () => ({
  hasTrackedPlanStorage: jest.fn(),
}));

jest.mock('../lib/plan-file-sync', () => ({
  getPlanFileSyncService: jest.fn(),
  planFileKey: (ref: {
    projectId: string;
    worktreeId: string;
    planId: string;
  }): string => JSON.stringify([ref.projectId, ref.worktreeId, ref.planId]),
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import { hasTrackedPlanStorage } from '../lib/tracked-plan-scope';
import { getPlanFileSyncService } from '../lib/plan-file-sync';
import { registerPlanFileVisibilityHandlers } from '../ipc/plan-file-visibility';

const mockedValidateId = jest.mocked(validateId);
const mockedHasTrackedPlanStorage = jest.mocked(hasTrackedPlanStorage);
const mockedGetPlanFileSyncService = jest.mocked(getPlanFileSyncService);

const acquireVisibility = jest.fn();
const releaseVisibility = jest.fn();

type FakeSender = EventEmitter & { id: number };

function fakeSender(id: number): FakeSender {
  const emitter = new EventEmitter() as FakeSender;
  emitter.id = id;
  return emitter;
}

const SCOPE = { projectId: 'proj-1', worktreeId: 'wt-1', planId: 'plan-1' };

describe('registerPlanFileVisibilityHandlers', () => {
  beforeAll(() => {
    registerPlanFileVisibilityHandlers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedHasTrackedPlanStorage.mockReturnValue(true);
    mockedGetPlanFileSyncService.mockReturnValue({
      acquireVisibility,
      releaseVisibility,
      // Only the two visibility methods are exercised through this handler;
      // the rest of the service surface is irrelevant to this suite.
    } as unknown as ReturnType<typeof getPlanFileSyncService>);
  });

  function handler(): (event: unknown, ...args: unknown[]) => unknown {
    const found = handlers.get(IPC_CHANNELS.trackedPlansFileVisibility);
    if (!found) {
      throw new Error('No handler registered for trackedPlansFileVisibility');
    }
    return found;
  }

  it('validates every id and forwards the boolean flag', () => {
    const sender = fakeSender(1);
    handler()(
      { sender },
      { ...SCOPE, consumerId: 'consumer-1', visible: true },
    );

    expect(mockedValidateId).toHaveBeenCalledWith('proj-1', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
    expect(mockedValidateId).toHaveBeenCalledWith('plan-1', 'planId');
    expect(mockedValidateId).toHaveBeenCalledWith('consumer-1', 'consumerId');
  });

  it('rejects a non-boolean visible flag', () => {
    const sender = fakeSender(1);
    expect(() =>
      handler()(
        { sender },
        { ...SCOPE, consumerId: 'consumer-1', visible: 'yes' },
      ),
    ).toThrow('visible must be a boolean');
    expect(acquireVisibility).not.toHaveBeenCalled();
  });

  it('acquire calls the service with `${sender.id}:${consumerId}`', () => {
    const sender = fakeSender(7);
    handler()(
      { sender },
      { ...SCOPE, consumerId: 'consumer-1', visible: true },
    );

    expect(acquireVisibility).toHaveBeenCalledWith(SCOPE, '7:consumer-1');
    expect(releaseVisibility).not.toHaveBeenCalled();
  });

  it('release calls the service with the same owner id', () => {
    const sender = fakeSender(7);
    handler()(
      { sender },
      { ...SCOPE, consumerId: 'consumer-1', visible: true },
    );
    releaseVisibility.mockClear();

    handler()(
      { sender },
      { ...SCOPE, consumerId: 'consumer-1', visible: false },
    );

    expect(releaseVisibility).toHaveBeenCalledWith(SCOPE, '7:consumer-1');
  });

  it('two consumers on the same plan are independent', () => {
    const sender = fakeSender(2);
    handler()({ sender }, { ...SCOPE, consumerId: 'a', visible: true });
    handler()({ sender }, { ...SCOPE, consumerId: 'b', visible: true });

    expect(acquireVisibility).toHaveBeenNthCalledWith(1, SCOPE, '2:a');
    expect(acquireVisibility).toHaveBeenNthCalledWith(2, SCOPE, '2:b');

    handler()({ sender }, { ...SCOPE, consumerId: 'a', visible: false });
    expect(releaseVisibility).toHaveBeenCalledTimes(1);
    expect(releaseVisibility).toHaveBeenCalledWith(SCOPE, '2:a');
  });

  it('ignores the request when the scope has no tracked-plan storage', () => {
    mockedHasTrackedPlanStorage.mockReturnValue(false);
    const sender = fakeSender(1);

    handler()(
      { sender },
      { ...SCOPE, consumerId: 'consumer-1', visible: true },
    );

    expect(acquireVisibility).not.toHaveBeenCalled();
    expect(releaseVisibility).not.toHaveBeenCalled();
  });

  it('throws when an id is invalid', () => {
    mockedValidateId.mockImplementationOnce(() => {
      throw new Error('Invalid projectId');
    });
    const sender = fakeSender(1);

    expect(() =>
      handler()(
        { sender },
        { ...SCOPE, consumerId: 'consumer-1', visible: true },
      ),
    ).toThrow('Invalid projectId');
    expect(acquireVisibility).not.toHaveBeenCalled();
  });

  it("destroyed releases only that sender's live leases", () => {
    const sender = fakeSender(3);
    handler()({ sender }, { ...SCOPE, consumerId: 'a', visible: true });
    handler()({ sender }, { ...SCOPE, consumerId: 'b', visible: true });
    handler()({ sender }, { ...SCOPE, consumerId: 'a', visible: false });
    releaseVisibility.mockClear();

    sender.emit('destroyed');

    expect(releaseVisibility).toHaveBeenCalledTimes(1);
    expect(releaseVisibility).toHaveBeenCalledWith(SCOPE, '3:b');
  });

  it("a different sender's leases are unaffected by another sender's destruction", () => {
    const senderA = fakeSender(4);
    const senderB = fakeSender(5);
    handler()(
      { sender: senderA },
      { ...SCOPE, consumerId: 'a', visible: true },
    );
    handler()(
      { sender: senderB },
      { ...SCOPE, consumerId: 'b', visible: true },
    );
    releaseVisibility.mockClear();

    senderA.emit('destroyed');

    expect(releaseVisibility).toHaveBeenCalledTimes(1);
    expect(releaseVisibility).toHaveBeenCalledWith(SCOPE, '4:a');
  });

  it('render-process-gone releases live leases', () => {
    const sender = fakeSender(6);
    handler()({ sender }, { ...SCOPE, consumerId: 'a', visible: true });
    releaseVisibility.mockClear();

    sender.emit('render-process-gone');

    expect(releaseVisibility).toHaveBeenCalledTimes(1);
    expect(releaseVisibility).toHaveBeenCalledWith(SCOPE, '6:a');
  });

  it('a main-frame cross-document navigation (reload) releases live leases', () => {
    const sender = fakeSender(8);
    handler()({ sender }, { ...SCOPE, consumerId: 'a', visible: true });
    releaseVisibility.mockClear();

    sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });

    expect(releaseVisibility).toHaveBeenCalledTimes(1);
    expect(releaseVisibility).toHaveBeenCalledWith(SCOPE, '8:a');
  });

  it('a same-document navigation does not release', () => {
    const sender = fakeSender(9);
    handler()({ sender }, { ...SCOPE, consumerId: 'a', visible: true });
    releaseVisibility.mockClear();

    sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
    });

    expect(releaseVisibility).not.toHaveBeenCalled();
  });

  it('a sub-frame navigation does not release', () => {
    const sender = fakeSender(10);
    handler()({ sender }, { ...SCOPE, consumerId: 'a', visible: true });
    releaseVisibility.mockClear();

    sender.emit('did-start-navigation', {
      isMainFrame: false,
      isSameDocument: false,
    });

    expect(releaseVisibility).not.toHaveBeenCalled();
  });
});
