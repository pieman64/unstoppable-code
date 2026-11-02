jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/validation', () => ({
  validateAbsolutePath: jest.fn(),
  validateId: jest.fn(),
}));

jest.mock('../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
}));

const mockStat = jest.fn();
const mockGetCanonicalState = jest.fn();

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): {
    getCanonicalState: typeof mockGetCanonicalState;
  } => ({
    getCanonicalState: mockGetCanonicalState,
  }),
}));

jest.mock('electron', () => ({
  shell: { showItemInFolder: jest.fn() },
}));

jest.mock('node:fs/promises', () => ({
  get stat(): typeof mockStat {
    return mockStat;
  },
  readFile: jest.fn(),
  open: jest.fn(),
  realpath: jest.fn(),
  writeFile: jest.fn(),
}));

import { open, readFile, realpath } from 'node:fs/promises';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { FileContentResponse } from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { getFileBrowserRoots } from '../lib/file-browser-roots';
import { validateAbsolutePath } from '../lib/validation';
import { registerFilePreviewHandlers } from '../ipc/file-preview';
import {
  unusedCallerResolver,
  unusedFileContentDispatcher,
} from './file-preview-fixtures';

const MAX_FULL_TEXT_BYTES = 5 * 1024 * 1024;

const mockedOpen = jest.mocked(open);
const mockedReadFile = jest.mocked(readFile);
const mockedRealpath = jest.mocked(realpath);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const mockedValidateAbsolutePath = jest.mocked(validateAbsolutePath);

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
interface MockBufferedFileHandle {
  read: jest.MockedFunction<(buffer: Buffer) => Promise<{ bytesRead: number }>>;
  close: jest.MockedFunction<() => Promise<void>>;
}

function getHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(([c]) => c === channel);
  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return call[1] as HandlerFn;
}

describe('fileReadContent handler', () => {
  function invoke(absolutePath: string): Promise<FileContentResponse> {
    return getHandler(IPC_CHANNELS.fileReadContent)(undefined, {
      absolutePath,
    }) as Promise<FileContentResponse>;
  }

  function invokeGeneratedImage(absolutePath: string): Promise<unknown> {
    return getHandler(IPC_CHANNELS.fileReadContent)(undefined, {
      absolutePath,
      allowedRoot: 'codex-generated-images',
    });
  }

  function mockStatSize(size: number, mtimeMs: number = 1700000000000): void {
    mockStat.mockResolvedValue({ size, mtimeMs, dev: 1, ino: 1 });
  }

  function mockBufferedRead(bufferContents: Buffer): MockBufferedFileHandle {
    const fileHandle = {
      read: jest.fn(),
      readFile: jest.fn().mockResolvedValue(bufferContents),
      stat: jest.fn().mockResolvedValue({
        size: bufferContents.length,
        mtimeMs: 1700000000000,
        dev: 1,
        ino: 1,
        isFile: () => true,
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    fileHandle.read.mockImplementation(
      (buffer: Buffer): Promise<{ bytesRead: number }> => {
        bufferContents.copy(buffer, 0, 0, bufferContents.length);
        return Promise.resolve({ bytesRead: bufferContents.length });
      },
    );
    mockedOpen.mockResolvedValue(fileHandle as never);
    return fileHandle;
  }

  function mockTextRead(content: string): MockBufferedFileHandle {
    return mockBufferedRead(Buffer.from(content, 'utf8'));
  }

  function mockBinaryRead(): void {
    mockBufferedRead(Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCanonicalState.mockResolvedValue({
      codexHome: '/tmp/codex-home',
    });
    registerFilePreviewHandlers(
      unusedFileContentDispatcher,
      unusedCallerResolver,
    );
  });

  it('rejects a generated-image UNC path before filesystem access', async () => {
    await expect(
      invokeGeneratedImage('\\\\attacker.example\\share\\image.png'),
    ).rejects.toThrow('network and device paths are not allowed');

    expect(mockedRealpath).not.toHaveBeenCalled();
    expect(mockStat).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it('rejects a generated image outside the canonical Codex image root', async () => {
    mockedRealpath
      .mockResolvedValueOnce('/tmp/outside/image.png')
      .mockResolvedValueOnce('/tmp/codex-home/generated_images');

    await expect(
      invokeGeneratedImage('/tmp/outside/image.png'),
    ).rejects.toThrow('outside the Codex generated-image root');
    expect(mockGetCanonicalState).toHaveBeenCalledTimes(1);
    expect(mockStat).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it('reads a regular image contained by the canonical Codex image root', async () => {
    mockedRealpath
      .mockResolvedValueOnce(
        '/tmp/codex-home/generated_images/nested/image.png',
      )
      .mockResolvedValueOnce('/tmp/codex-home/generated_images');
    mockStatSize(3);
    mockBufferedRead(Buffer.from('PNG'));

    await expect(
      invokeGeneratedImage('/tmp/codex-home/generated_images/nested/image.png'),
    ).resolves.toMatchObject({
      kind: 'image',
      filename: 'image.png',
    });
    expect(mockGetCanonicalState).toHaveBeenCalledTimes(1);
  });

  it('returns an image data URI with the correct mime type', async () => {
    mockStatSize(128);
    mockedReadFile.mockResolvedValue(Buffer.from('PNG'));

    const result = await invoke('/tmp/photo.png');

    expect(result.kind).toBe('image');
    expect(result.content).toMatch(/^data:image\/png;base64,/);
    expect(result.filename).toBe('photo.png');
    expect(result.sizeBytes).toBe(128);
    expect(result.truncated).toBe(false);
    expect(result.modifiedAtMs).toBe(1700000000000);
  });

  it('returns markdown content for markdown files', async () => {
    const content = '# Heading\n\nSome markdown.';
    mockStatSize(Buffer.byteLength(content, 'utf8'));
    mockTextRead(content);

    const result = await invoke('/tmp/README.md');

    expect(result).toEqual({
      kind: 'markdown',
      content,
      filename: 'README.md',
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      truncated: false,
      modifiedAtMs: 1700000000000,
    });
  });

  it('returns plain text content when the file is under the cap', async () => {
    const content = 'terraform {\n  required_version = ">= 1.0"\n}\n';
    mockStatSize(Buffer.byteLength(content, 'utf8'));
    mockTextRead(content);

    const result = await invoke('/tmp/main.tf');

    expect(result).toEqual({
      kind: 'text',
      content,
      filename: 'main.tf',
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      truncated: false,
      modifiedAtMs: 1700000000000,
    });
  });

  // The scoped branch's containment, symlink and identity checks are pinned
  // on real filesystems by ipc/__tests__/file-read-content-golden.test.ts;
  // here only its delegation to the desktop dispatcher is checked.
  describe('scoped workspace reads', () => {
    const scopedRequest = {
      absolutePath: '/workspace/src/file.ts',
      workspaceTarget: { projectId: 'project-1', worktreeId: 'worktree-1' },
    };
    const sender = { id: 9 };
    const caller = {
      principalId: 'local',
      clientInstanceId: 'electron-web-contents:9',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop' as const,
      grants: ['worker.filesystem.read' as const],
    };
    const query = jest.fn();

    beforeEach(() => {
      mockedRegisterIpcHandler.mockClear();
      query.mockReset();
      registerFilePreviewHandlers(
        {
          queryFileContentForLegacyIpc: query,
          queryLinkResolveForLegacyIpc:
            unusedFileContentDispatcher.queryLinkResolveForLegacyIpc,
          saveTextFileForLegacyIpc:
            unusedFileContentDispatcher.saveTextFileForLegacyIpc,
        },
        () => caller,
      );
    });

    it('returns the projected legacy response without touching the filesystem', async () => {
      const legacyResult = {
        kind: 'text',
        content: 'safe',
        filename: 'file.ts',
        sizeBytes: 4,
        truncated: false,
        modifiedAtMs: 1,
      };
      query.mockResolvedValue({ canonicalResult: null, legacyResult });
      await expect(
        getHandler(IPC_CHANNELS.fileReadContent)({ sender }, scopedRequest),
      ).resolves.toBe(legacyResult);
      expect(query).toHaveBeenCalledWith(
        {
          scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
          absolutePath: '/workspace/src/file.ts',
        },
        { caller },
        { sender },
      );
      expect(mockedOpen).not.toHaveBeenCalled();
      expect(mockedRealpath).not.toHaveBeenCalled();
      expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    });

    it('rethrows the runtime cause of a typed failure', async () => {
      const { CanopyOperationError } = await import('@canopy/core-runtime');
      query.mockRejectedValue(
        new CanopyOperationError(
          {
            kind: 'not_found',
            code: 'worker.filesystem.file.outsideRoots',
            message: 'typed',
            retry: { kind: 'never' },
          },
          new Error('Cannot read file outside the target project roots'),
        ),
      );
      await expect(
        getHandler(IPC_CHANNELS.fileReadContent)({ sender }, scopedRequest),
      ).rejects.toThrow('Cannot read file outside the target project roots');
    });

    it('keeps generated-image reads off the scoped path', async () => {
      mockedRealpath
        .mockResolvedValueOnce('/tmp/outside/image.png')
        .mockResolvedValueOnce('/tmp/codex-home/generated_images');
      await expect(
        getHandler(IPC_CHANNELS.fileReadContent)(
          { sender },
          { ...scopedRequest, allowedRoot: 'codex-generated-images' },
        ),
      ).rejects.toThrow('outside the Codex generated-image root');
      expect(query).not.toHaveBeenCalled();
    });
  });

  it('returns truncated text content when the file exceeds 5MB', async () => {
    const contentBuffer = Buffer.alloc(MAX_FULL_TEXT_BYTES, 'x');
    mockStatSize(MAX_FULL_TEXT_BYTES + 1);
    mockBufferedRead(contentBuffer);

    const result = await invoke('/tmp/large.log');

    expect(result.kind).toBe('text');
    expect(result.filename).toBe('large.log');
    expect(result.sizeBytes).toBe(MAX_FULL_TEXT_BYTES + 1);
    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(MAX_FULL_TEXT_BYTES);
    expect(result.modifiedAtMs).toBe(1700000000000);
  });

  it('returns unsupported when a candidate text file contains null bytes', async () => {
    mockStatSize(32);
    mockBinaryRead();

    const result = await invoke('/tmp/file.kdl');

    expect(result).toEqual({
      kind: 'unsupported',
      content: '',
      filename: 'file.kdl',
      sizeBytes: 32,
      truncated: false,
      modifiedAtMs: 1700000000000,
    });
  });

  it('returns unsupported for known binary extensions without reading content', async () => {
    mockStatSize(2048);

    const result = await invoke('/tmp/archive.zip');

    expect(result).toEqual({
      kind: 'unsupported',
      content: '',
      filename: 'archive.zip',
      sizeBytes: 2048,
      truncated: false,
      modifiedAtMs: 1700000000000,
    });
    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it('returns a missing response when the file does not exist', async () => {
    const enoent: NodeJS.ErrnoException = new Error(
      'ENOENT: no such file or directory, stat /tmp/gone.md',
    );
    enoent.code = 'ENOENT';
    mockStat.mockRejectedValueOnce(enoent);

    const result = await invoke('/tmp/gone.md');

    expect(result).toEqual({
      kind: 'missing',
      content: '',
      filename: 'gone.md',
      sizeBytes: 0,
      truncated: false,
      modifiedAtMs: 0,
    });
    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it('returns a missing response when the file is deleted before text read', async () => {
    const enoent: NodeJS.ErrnoException = new Error(
      'ENOENT: no such file or directory, open /tmp/gone.md',
    );
    enoent.code = 'ENOENT';
    mockStatSize(128);
    mockedOpen.mockRejectedValueOnce(enoent);

    const result = await invoke('/tmp/gone.md');

    expect(result).toEqual({
      kind: 'missing',
      content: '',
      filename: 'gone.md',
      sizeBytes: 0,
      truncated: false,
      modifiedAtMs: 0,
    });
  });

  it('returns a missing response when the file is deleted before image read', async () => {
    const enoent: NodeJS.ErrnoException = new Error(
      'ENOENT: no such file or directory, open /tmp/gone.png',
    );
    enoent.code = 'ENOENT';
    mockStatSize(128);
    mockedReadFile.mockRejectedValueOnce(enoent);

    const result = await invoke('/tmp/gone.png');

    expect(result).toEqual({
      kind: 'missing',
      content: '',
      filename: 'gone.png',
      sizeBytes: 0,
      truncated: false,
      modifiedAtMs: 0,
    });
  });

  it('rethrows non-ENOENT stat failures', async () => {
    const eacces: NodeJS.ErrnoException = new Error(
      'EACCES: permission denied',
    );
    eacces.code = 'EACCES';
    mockStat.mockRejectedValueOnce(eacces);

    await expect(invoke('/tmp/secret.md')).rejects.toThrow(
      'EACCES: permission denied',
    );
  });

  it('rejects paths that fail absolute-path validation', async () => {
    mockedValidateAbsolutePath.mockImplementationOnce(() => {
      throw new Error('Invalid absolutePath: must be an absolute path');
    });

    await expect(invoke('relative/path.txt')).rejects.toThrow(
      'Invalid absolutePath: must be an absolute path',
    );
    expect(mockStat).not.toHaveBeenCalled();
  });
});
