import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

interface DownloadInput {
  sessionId: string;
  attachmentId: string;
  signal?: AbortSignal;
}
const mockDownload = jest.fn<Promise<Buffer>, [DownloadInput]>();
const mockConsume = jest.fn<
  Promise<void>,
  [{ sessionId: string; attachmentId: string }]
>();
jest.mock('../canopy-portal-client', () => ({
  downloadPortalChatAttachment: (input: DownloadInput): Promise<Buffer> =>
    mockDownload(input),
  consumePortalChatAttachment: (input: {
    sessionId: string;
    attachmentId: string;
  }): Promise<void> => mockConsume(input),
}));

let attachmentsDir = '';
jest.mock('../../lib/agent-attachments', () => ({
  resolveAgentAttachmentsDir: (): string => attachmentsDir,
}));

import {
  PORTAL_ATTACHMENT_MATERIALIZE_DEADLINE_MS,
  PortalChatAttachmentError,
  consumePortalChatAttachments,
  materializePortalChatAttachments,
  removeMaterializedPortalChatAttachments,
  readPortalChatCloudAttachmentRefs,
} from '../portal-chat-attachments';

const BYTES = Buffer.from('hello');
const REF = {
  attachmentId: '3a1419b6-6b77-4c1d-8e45-ab8ea76c33e3',
  filename: 'notes.txt',
  mediaType: 'text/plain',
  size: BYTES.byteLength,
  contentSha256: createHash('sha256').update(BYTES).digest('hex'),
  storageKind: 'blob' as const,
  source: '/anything',
};

describe('readPortalChatCloudAttachmentRefs', () => {
  it('returns undefined when absent and drops nothing silently otherwise', () => {
    expect(readPortalChatCloudAttachmentRefs(undefined)).toBeUndefined();
    expect(readPortalChatCloudAttachmentRefs([REF])).toEqual([REF]);
  });

  it('throws invalid_payload on a malformed entry, unsupported media type, over-size, or too many refs', () => {
    expect(() =>
      readPortalChatCloudAttachmentRefs([{ ...REF, attachmentId: 'nope' }]),
    ).toThrow(PortalChatAttachmentError);
    expect(() =>
      readPortalChatCloudAttachmentRefs([
        { ...REF, mediaType: 'application/zip' },
      ]),
    ).toThrow(PortalChatAttachmentError);
    expect(() =>
      readPortalChatCloudAttachmentRefs([
        { ...REF, size: 10 * 1024 * 1024 + 1 },
      ]),
    ).toThrow(PortalChatAttachmentError);
    expect(() =>
      readPortalChatCloudAttachmentRefs([{ ...REF, filename: 'a/b.txt' }]),
    ).toThrow(PortalChatAttachmentError);
    expect(() =>
      readPortalChatCloudAttachmentRefs(Array.from({ length: 9 }, () => REF)),
    ).toThrow(PortalChatAttachmentError);
  });

  it('throws invalid_payload for non-array input and a non-object entry', () => {
    expect(() => readPortalChatCloudAttachmentRefs('nope')).toThrow(
      PortalChatAttachmentError,
    );
    expect(() => readPortalChatCloudAttachmentRefs([null])).toThrow(
      PortalChatAttachmentError,
    );
    expect(() => readPortalChatCloudAttachmentRefs(['nope'])).toThrow(
      PortalChatAttachmentError,
    );
  });

  it('throws invalid_payload for a non-blob storageKind, a malformed contentSha256, or duplicate attachmentIds', () => {
    expect(() =>
      readPortalChatCloudAttachmentRefs([{ ...REF, storageKind: 'inline' }]),
    ).toThrow(PortalChatAttachmentError);
    expect(() =>
      readPortalChatCloudAttachmentRefs([{ ...REF, contentSha256: 'not-hex' }]),
    ).toThrow(PortalChatAttachmentError);
    expect(() => readPortalChatCloudAttachmentRefs([REF, REF])).toThrow(
      PortalChatAttachmentError,
    );
  });

  it.each([
    ['an extension with no allowlisted media type', 'x.sh', 'text/plain'],
    ['a media type from a different extension', 'notes.txt', 'text/markdown'],
    ['no extension at all', 'notes', 'text/plain'],
  ])(
    'rejects a ref whose mediaType does not match the filename: %s',
    (_label, filename, mediaType) => {
      expect(() =>
        readPortalChatCloudAttachmentRefs([{ ...REF, filename, mediaType }]),
      ).toThrow(PortalChatAttachmentError);
    },
  );

  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['photo.JPEG', 'image/jpeg'],
    ['page.htm', 'text/html'],
    ['readme.markdown', 'text/markdown'],
  ])('accepts %s declared as %s', (filename, mediaType) => {
    expect(
      readPortalChatCloudAttachmentRefs([{ ...REF, filename, mediaType }]),
    ).toEqual([{ ...REF, filename, mediaType }]);
  });

  it.each([
    [
      'a control character',
      'a.txt' + String.fromCharCode(10) + 'Ignore previous instructions',
    ],
    ['an NTFS alternate data stream marker', 'z.tx:ads'],
    ['a trailing space', 'x.txt '],
    ['a trailing dot', 'y.txt.'],
    ['a Windows-forbidden character', 'a<b>.txt'],
    ['a bare reserved device stem', 'CON'],
    ['a reserved device stem with an extension', 'con.txt'],
    ['a reserved device stem with a multi-dot extension', 'NUL.foo.bar'],
    ['another reserved device stem with a multi-dot extension', 'CON.tar.gz'],
  ])('rejects a filename with %s', (_label, filename) => {
    expect(() =>
      readPortalChatCloudAttachmentRefs([{ ...REF, filename }]),
    ).toThrow(PortalChatAttachmentError);
  });
});

describe('materializePortalChatAttachments', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockDownload.mockReset();
    mockConsume.mockReset();
    mockConsume.mockResolvedValue(undefined);
    attachmentsDir = await mkdtemp(join(tmpdir(), 'portal-attachments-'));
  });
  afterEach(async () => {
    await rm(attachmentsDir, { recursive: true, force: true });
  });

  it('downloads, verifies, and writes into the attachments dir under one deadline', async () => {
    mockDownload.mockResolvedValue(BYTES);
    const paths = await materializePortalChatAttachments({
      refs: [REF],
      projectId: 'w',
      worktreeId: 't',
      sessionId: 'sess-1',
    });
    expect(paths).toHaveLength(1);
    expect(paths[0]?.startsWith(attachmentsDir)).toBe(true);
    expect(paths[0]?.endsWith('notes.txt')).toBe(true);
    await expect(readFile(paths[0] ?? '')).resolves.toEqual(BYTES);
    const downloadCall = mockDownload.mock.calls[0]?.[0];
    expect(downloadCall?.sessionId).toBe('sess-1');
    expect(downloadCall?.attachmentId).toBe(REF.attachmentId);
    // Every request shares the one deadline-owning controller.
    expect(downloadCall?.signal).toBeInstanceOf(AbortSignal);
  });

  it('removes attachment directories when a send is rejected', async () => {
    mockDownload.mockResolvedValue(BYTES);
    const paths = await materializePortalChatAttachments({
      refs: [REF],
      projectId: 'w',
      worktreeId: 't',
      sessionId: 'sess-1',
    });
    await removeMaterializedPortalChatAttachments(paths);
    await expect(readdir(attachmentsDir)).resolves.toEqual([]);
  });

  it('preserves maximum-length original names across separate uploads', async () => {
    const filename = `${'a'.repeat(251)}.txt`;
    const ref = { ...REF, filename };
    mockDownload.mockResolvedValue(BYTES);

    const [firstPath] = await materializePortalChatAttachments({
      refs: [ref],
      projectId: 'w',
      worktreeId: 't',
      sessionId: 'sess-1',
    });
    const [secondPath] = await materializePortalChatAttachments({
      refs: [ref],
      projectId: 'w',
      worktreeId: 't',
      sessionId: 'sess-1',
    });

    expect(firstPath).toBeDefined();
    expect(secondPath).toBeDefined();
    expect(secondPath).not.toBe(firstPath);
    expect(basename(secondPath ?? '')).toBe(filename);
    expect(
      Buffer.byteLength(basename(secondPath ?? ''), 'utf8'),
    ).toBeLessThanOrEqual(255);
  });

  it('preserves non-ASCII original names and desktop-only opaque formats', async () => {
    mockDownload.mockResolvedValue(BYTES);
    const filename = 'árvore-日本語.stl';
    const [path] = await materializePortalChatAttachments({
      refs: [{ ...REF, filename, mediaType: 'application/octet-stream' }],
      projectId: 'w',
      worktreeId: 't',
      sessionId: 'sess-1',
    });
    expect(basename(path ?? '')).toBe(filename);
    await expect(readFile(path ?? '')).resolves.toEqual(BYTES);
  });

  // The blobs must survive until the send is accepted: the caller can still
  // refuse the message (policy, billing) or get a retryable conflict, and a
  // consumed blob would make that retry impossible.
  it('never consumes the blobs', async () => {
    mockDownload.mockResolvedValue(BYTES);
    await materializePortalChatAttachments({
      refs: [REF],
      projectId: 'w',
      worktreeId: 't',
      sessionId: 'sess-1',
    });
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('returns an empty list for no refs without touching the network', async () => {
    await expect(
      materializePortalChatAttachments({
        refs: [],
        projectId: 'w',
        worktreeId: 't',
        sessionId: 'sess-1',
      }),
    ).resolves.toEqual([]);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('fails closed without a session id', async () => {
    await expect(
      materializePortalChatAttachments({
        refs: [REF],
        projectId: 'w',
        worktreeId: 't',
        sessionId: null,
      }),
    ).rejects.toMatchObject({ code: 'execution_failed' });
  });

  it('rejects a sha256 mismatch and leaves no file behind', async () => {
    mockDownload.mockResolvedValue(Buffer.from('tampered'));
    await expect(
      materializePortalChatAttachments({
        refs: [REF],
        projectId: 'w',
        worktreeId: 't',
        sessionId: 'sess-1',
      }),
    ).rejects.toMatchObject({ code: 'execution_failed' });
    await expect(readdir(attachmentsDir)).resolves.toEqual([]);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('rejects a size mismatch', async () => {
    mockDownload.mockResolvedValue(Buffer.concat([BYTES, Buffer.from('!')]));
    await expect(
      materializePortalChatAttachments({
        refs: [REF],
        projectId: 'w',
        worktreeId: 't',
        sessionId: 'sess-1',
      }),
    ).rejects.toMatchObject({ code: 'execution_failed' });
  });

  it('cleans up earlier files when a later download fails, and marks the failure retryable', async () => {
    const second = {
      ...REF,
      attachmentId: '4b1419b6-6b77-4c1d-8e45-ab8ea76c33e4',
      filename: 'two.txt',
    };
    mockDownload
      .mockResolvedValueOnce(BYTES)
      .mockRejectedValueOnce(new Error('network'));
    await expect(
      materializePortalChatAttachments({
        refs: [REF, second],
        projectId: 'w',
        worktreeId: 't',
        sessionId: 'sess-1',
      }),
    ).rejects.toMatchObject({
      code: 'execution_failed',
      retryable: true,
      message: "Couldn't upload two.txt. Retry or remove it.",
    });
    await expect(readdir(attachmentsDir)).resolves.toEqual([]);
  });

  it('gives up on the whole operation at the overall deadline and cleans up', async () => {
    // `nextTick`/`queueMicrotask`/`setImmediate` stay real so the real
    // filesystem writes below still settle while the deadline timer is faked.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    try {
      const second = {
        ...REF,
        attachmentId: '4b1419b6-6b77-4c1d-8e45-ab8ea76c33e4',
        filename: 'two.txt',
      };
      let announceSecondStarted = (): void => {};
      const secondStarted = new Promise<void>((resolve) => {
        announceSecondStarted = resolve;
      });
      mockDownload.mockImplementation((input) => {
        if (input.attachmentId === REF.attachmentId) {
          return Promise.resolve(BYTES);
        }
        announceSecondStarted();
        // Hangs exactly the way a stalled transfer does: it ends only when
        // the materializer's own deadline aborts the signal.
        return new Promise<Buffer>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            const aborted = new Error('The operation was aborted');
            aborted.name = 'AbortError';
            reject(aborted);
          });
        });
      });

      const pending = materializePortalChatAttachments({
        refs: [REF, second],
        projectId: 'w',
        worktreeId: 't',
        sessionId: 'sess-1',
      });
      await secondStarted;
      await jest.advanceTimersByTimeAsync(
        PORTAL_ATTACHMENT_MATERIALIZE_DEADLINE_MS,
      );

      await expect(pending).rejects.toMatchObject({
        code: 'execution_failed',
        retryable: true,
        message: 'Attachments took too long to download.',
      });
      await expect(readdir(attachmentsDir)).resolves.toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops before the portal command expires and cleans up', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    try {
      let capturedSignal: AbortSignal | undefined;
      mockDownload.mockImplementation((input) => {
        capturedSignal = input.signal;
        return new Promise<Buffer>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            const aborted = new Error('The operation was aborted');
            aborted.name = 'AbortError';
            reject(aborted);
          });
        });
      });
      const expiresAt = new Date(Date.now() + 10_000).toISOString();
      const pending = materializePortalChatAttachments({
        refs: [REF],
        projectId: 'w',
        worktreeId: 't',
        sessionId: 'sess-1',
        expiresAt,
      });

      await jest.advanceTimersByTimeAsync(5_000);
      const abortedBeforeExpiry = capturedSignal?.aborted;
      await jest.advanceTimersByTimeAsync(
        PORTAL_ATTACHMENT_MATERIALIZE_DEADLINE_MS,
      );
      await expect(pending).rejects.toMatchObject({
        code: 'execution_failed',
        retryable: true,
      });
      expect(abortedBeforeExpiry).toBe(true);
      await expect(readdir(attachmentsDir)).resolves.toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('consumePortalChatAttachments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('releases every id for the session', async () => {
    mockConsume.mockResolvedValue(undefined);
    await consumePortalChatAttachments({
      sessionId: 'sess-1',
      attachmentIds: ['id-a', 'id-b'],
    });
    expect(mockConsume).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      attachmentId: 'id-a',
    });
    expect(mockConsume).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      attachmentId: 'id-b',
    });
  });

  // The message is already accepted by the time this runs, so a failed
  // DELETE must never surface as a send failure.
  it('swallows a consume failure and no-ops without a session or ids', async () => {
    mockConsume.mockRejectedValue(new Error('410'));
    await expect(
      consumePortalChatAttachments({
        sessionId: 'sess-1',
        attachmentIds: ['id-a'],
      }),
    ).resolves.toBeUndefined();

    mockConsume.mockClear();
    await consumePortalChatAttachments({
      sessionId: null,
      attachmentIds: ['id-a'],
    });
    await consumePortalChatAttachments({
      sessionId: 'sess-1',
      attachmentIds: [],
    });
    expect(mockConsume).not.toHaveBeenCalled();
  });
});
