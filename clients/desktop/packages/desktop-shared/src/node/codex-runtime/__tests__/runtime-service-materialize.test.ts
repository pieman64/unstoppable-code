import { createCodexRuntimeService } from '../runtime-service';
import type { CodexThreadHandle } from '../thread-handle';

function createHandleStub(injectItems: jest.Mock): {
  handle: CodexThreadHandle;
  deleteMock: jest.Mock;
} {
  const deleteMock = jest.fn(() => Promise.resolve());
  const handle: CodexThreadHandle = {
    threadId: 'thread-new',
    capabilitySnapshotId: 'snapshot-new',
    runTurn: () =>
      Promise.reject(new Error('runTurn is not exercised by this spec')),
    injectItems,
    interrupt: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
    delete: deleteMock,
  };
  return { handle, deleteMock };
}

describe('CodexRuntimeService materializeThread', () => {
  it('skips the injection entirely when there is nothing to inject', async () => {
    // `thread/inject_items` with an empty array is a request the bundled
    // app-server has no reason to accept, and `materializeThread` deletes the
    // freshly started thread on any injection failure. That would fail the tool
    // update on exactly the case an empty item list is reachable from: a legacy
    // lease whose entire loaded tail was provider-private reasoning, which
    // sanitizes to nothing while real history existed. The client-side
    // reconstruction path already guards this (`seedItems.length > 0`); the
    // service must match it.
    const injectItems = jest.fn(() => Promise.resolve());
    const { handle, deleteMock } = createHandleStub(injectItems);
    const service = createCodexRuntimeService();
    jest
      .spyOn(service, 'startThread')
      .mockImplementation(() => Promise.resolve(handle));

    await expect(
      service.materializeThread({
        params: { cwd: '/tmp/repo' },
        capabilitySnapshotId: 'snapshot-new',
        items: [],
      }),
    ).resolves.toBe(handle);

    expect(injectItems).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('still injects a non-empty history', async () => {
    const injectItems = jest.fn(() => Promise.resolve());
    const { handle } = createHandleStub(injectItems);
    const items = [{ type: 'message', role: 'user', content: [] }];
    const service = createCodexRuntimeService();
    jest
      .spyOn(service, 'startThread')
      .mockImplementation(() => Promise.resolve(handle));

    await expect(
      service.materializeThread({
        params: { cwd: '/tmp/repo' },
        capabilitySnapshotId: 'snapshot-new',
        items,
      }),
    ).resolves.toBe(handle);

    expect(injectItems).toHaveBeenCalledWith(items);
    await service.shutdown();
  });

  it('deletes the started thread when a non-empty injection fails', async () => {
    const injectItems = jest.fn(() =>
      Promise.reject(new Error('inject rejected')),
    );
    const { handle, deleteMock } = createHandleStub(injectItems);
    const service = createCodexRuntimeService();
    jest
      .spyOn(service, 'startThread')
      .mockImplementation(() => Promise.resolve(handle));

    await expect(
      service.materializeThread({
        params: { cwd: '/tmp/repo' },
        capabilitySnapshotId: 'snapshot-new',
        items: [{ type: 'message', role: 'user', content: [] }],
      }),
    ).rejects.toThrow('inject rejected');
    expect(deleteMock).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });
});
