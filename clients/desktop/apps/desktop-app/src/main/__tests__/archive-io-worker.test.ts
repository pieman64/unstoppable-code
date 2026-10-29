import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParentPort } from 'electron';
import { startArchiveIoWorker } from '../archive/archive-io-worker';
import type {
  ArchiveIoRequest,
  ArchiveIoResponse,
} from '../archive/archive-io-protocol';
import {
  isArchiveIoRequest,
  isArchiveIoResponse,
} from '../archive/archive-io-protocol';

class FakeParentPort extends EventEmitter implements ParentPort {
  public readonly postMessage = jest.fn<void, [ArchiveIoResponse]>();
}

describe('archive I/O worker', () => {
  let root = '';
  const originalNoAsar = process.noAsar;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archive-io-worker-'));
  });

  afterEach(async () => {
    process.noAsar = originalNoAsar;
    await rm(root, { recursive: true, force: true });
  });

  it('disables Electron asar redirection before reporting ready', () => {
    process.noAsar = false;
    const parent = new FakeParentPort();
    parent.postMessage.mockImplementation(() => {
      expect(process.noAsar).toBe(true);
    });

    startArchiveIoWorker(parent, jest.fn());

    expect(process.noAsar).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith({
      version: 1,
      type: 'ready',
      workerPid: process.pid,
    });
  });

  it('handshakes and acknowledges cleanup after the terminal result', async () => {
    const parent = new FakeParentPort();
    startArchiveIoWorker(parent, jest.fn());
    expect(parent.postMessage).toHaveBeenCalledWith({
      version: 1,
      type: 'ready',
      workerPid: process.pid,
    });
    const allowedRoot = join(root, 'containers');
    const target = join(allowedRoot, 'container-1');
    await mkdir(target, { recursive: true });
    const request: ArchiveIoRequest = {
      version: 1,
      type: 'remove-directory',
      requestId: 'request-1',
      operationId: 'operation-1',
      projectId: 'project-1',
      containerId: 'container-1',
      expectedCreatedAt: '2026-09-21T12:00:00.000Z',
      input: { path: target, allowedRoot },
    };

    parent.emit('message', { data: request });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (
        parent.postMessage.mock.calls.some(
          ([response]) => response.type === 'cleanup-complete',
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const responses = parent.postMessage.mock.calls.map(
      ([response]) => response,
    );
    const resultIndex = responses.findIndex(
      (response) => response.type === 'result',
    );
    const cleanupIndex = responses.findIndex(
      (response) => response.type === 'cleanup-complete',
    );
    expect(responses.filter((response) => response.type === 'error')).toEqual(
      [],
    );
    expect(resultIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(resultIndex);
  });

  it('returns a terminal error for a correlatable malformed message', async () => {
    const parent = new FakeParentPort();
    startArchiveIoWorker(parent, jest.fn());
    parent.postMessage.mockClear();

    parent.emit('message', {
      data: { version: 2, type: 'remove-directory', requestId: 'bad' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(parent.postMessage.mock.calls.map(([response]) => response)).toEqual(
      [
        {
          version: 1,
          type: 'error',
          requestId: 'bad',
          code: 'ARCHIVE_IO_INVALID_REQUEST',
          message: 'Archive I/O worker received an invalid request.',
        },
        {
          version: 1,
          type: 'cleanup-complete',
          requestId: 'bad',
          childCleanup: 'not-required',
        },
      ],
    );
  });

  it('validates typed request identities and operation-specific results', () => {
    expect(
      isArchiveIoResponse({
        version: 1,
        type: 'accepted',
        requestId: 'request-1',
      }),
    ).toBe(true);
    expect(
      isArchiveIoRequest({
        version: 1,
        type: 'remove-directory',
        requestId: 'request-1',
        operationId: 'operation-1',
        projectId: 'project-1',
        containerId: 'container-1',
        expectedCreatedAt: 'not-an-iso-date',
        input: { path: join(root, 'target'), allowedRoot: root },
      }),
    ).toBe(false);
    expect(
      isArchiveIoResponse({
        version: 1,
        type: 'result',
        requestId: 'request-1',
        operationType: 'remove-directory',
        result: { removed: false },
      }),
    ).toBe(false);
    expect(
      isArchiveIoResponse({
        version: 1,
        type: 'result',
        requestId: 'request-1',
        operationType: 'remove-directory',
        result: { removed: true },
      }),
    ).toBe(true);
    expect(
      isArchiveIoResponse({
        version: 1,
        type: 'result',
        requestId: 'request-1',
        operationType: 'capture-git',
        result: { repositories: [], gitChanges: {} },
      }),
    ).toBe(false);
    expect(
      isArchiveIoResponse({
        version: 1,
        type: 'result',
        requestId: 'request-1',
        operationType: 'capture-git',
        result: {
          repositories: [
            {
              repoId: 'repo-1',
              repoName: 'Repo',
              relativePath: '.',
              referenceRepoPath: root,
              comparisonBaseCommit: 'a'.repeat(40),
              headCommit: 'b'.repeat(40),
              indexSnapshotCommit: 'b'.repeat(40),
              worktreeSnapshotCommit: 'b'.repeat(40),
              snapshotRef: 'refs/app/archive/repo-1',
            },
          ],
          gitChanges: {
            status: 'unavailable',
            capturedAt: '2026-09-21T12:01:00.000Z',
          },
        },
      }),
    ).toBe(true);
  });
});
