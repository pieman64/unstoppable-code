import type * as Paths from '../lib/paths';

const mockOpenExternal = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
const mockShowItemInFolder = jest.fn<void, [string]>();
const mockCreateThumbnailFromPath = jest.fn<
  Promise<{ isEmpty: () => boolean; toDataURL: () => string }>,
  [string, { width: number; height: number }]
>();
const mockIsE2eBuild = jest.fn<boolean, []>(() => false);

// Pin the production branch of openExternalGuarded instead of relying on the
// injected `__CANOPY_E2E__` global.
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockIsE2eBuild(),
}));

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

jest.mock('../lib/paths', () => {
  const actual = jest.requireActual<typeof Paths>('../lib/paths');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      getSharedContainersRootDir: {
        configurable: true,
        enumerable: true,
        value: (): string => '/canopy-data/shared-containers',
        writable: true,
      },
    },
  );
});

jest.mock('electron', () => ({
  shell: {
    get openExternal(): typeof mockOpenExternal {
      return mockOpenExternal;
    },
    get showItemInFolder(): typeof mockShowItemInFolder {
      return mockShowItemInFolder;
    },
  },
  nativeImage: {
    createThumbnailFromPath: (
      absolutePath: string,
      size: { width: number; height: number },
    ): ReturnType<typeof mockCreateThumbnailFromPath> =>
      mockCreateThumbnailFromPath(absolutePath, size),
  },
}));

jest.mock('node:fs/promises', () => ({
  lstat: jest.fn(),
  stat: jest.fn(),
  readFile: jest.fn(),
  open: jest.fn(),
  realpath: jest.fn(),
  writeFile: jest.fn(),
}));

import {
  lstat,
  stat,
  readFile,
  open,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import { statSync, type Stats } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  FileDocumentBytesRequest,
  FileDocumentBytesResponse,
} from '@canopy/desktop-shared/types';
import {
  documentInvokeEvent,
  documentRoots,
  unusedCallerResolver,
  unusedFileContentDispatcher,
} from './file-preview-fixtures';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { FilePreviewResponse } from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import {
  fileUrlToAbsolutePath,
  registerFilePreviewHandlers,
} from '../ipc/file-preview';
import { getFileBrowserRoots } from '../lib/file-browser-roots';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedStat = jest.mocked(stat);
const mockedReadFile = jest.mocked(readFile);
const mockedOpen = jest.mocked(open);
const mockedRealpath = jest.mocked(realpath);
const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as HandlerFn;
}

describe('fileReadPreview handler', () => {
  function invoke(
    absolutePath: string,
    options: { videoFrame?: boolean } = {},
  ): Promise<FilePreviewResponse> {
    return getHandler(IPC_CHANNELS.fileReadPreview)(undefined, {
      absolutePath,
      ...options,
    }) as Promise<FilePreviewResponse>;
  }

  function mockStatSize(size: number, mtimeMs: number = 1700000000000): void {
    mockedStat.mockResolvedValue({ size, mtimeMs } as never);
  }

  function mockFileRead(content: string): void {
    const buf = Buffer.from(content, 'utf8');
    mockBufferedRead(buf);
  }

  function mockBufferedRead(buf: Buffer): void {
    const fh = {
      read: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    fh.read.mockImplementation(
      (buffer: Buffer): Promise<{ bytesRead: number }> => {
        buf.copy(buffer, 0, 0, buf.length);
        return Promise.resolve({ bytesRead: buf.length });
      },
    );
    mockedOpen.mockResolvedValue(fh as never);
  }

  function mockBinaryFileRead(): void {
    const buf = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]); // "He\0llo"
    mockBufferedRead(buf);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    registerFilePreviewHandlers(
      unusedFileContentDispatcher,
      unusedCallerResolver,
    );
  });

  describe('extension classification', () => {
    it('classifies image extensions', async () => {
      mockStatSize(100);
      mockedReadFile.mockResolvedValue(Buffer.from('PNG'));

      const result = await invoke('/tmp/photo.png');
      expect(result.kind).toBe('image');
    });

    it('classifies markdown extensions', async () => {
      mockStatSize(50);
      mockFileRead('# Hello');

      const result = await invoke('/tmp/readme.md');
      expect(result.kind).toBe('markdown');
    });

    it('classifies text extensions', async () => {
      mockStatSize(20);
      mockFileRead('const x = 1;');

      const result = await invoke('/tmp/index.ts');
      expect(result.kind).toBe('text');
    });

    it('classifies unsupported extensions', async () => {
      mockStatSize(1000);

      const result = await invoke('/tmp/archive.zip');
      expect(result.kind).toBe('unsupported');
      expect(result.content).toBe('');
      expect(mockedReadFile).not.toHaveBeenCalled();
      expect(mockedOpen).not.toHaveBeenCalled();
    });

    it('classifies .mdx as markdown', async () => {
      mockStatSize(30);
      mockFileRead('## MDX file');

      const result = await invoke('/tmp/page.mdx');
      expect(result.kind).toBe('markdown');
    });

    it('classifies .json as text', async () => {
      mockStatSize(15);
      mockFileRead('{"key":"val"}');

      const result = await invoke('/tmp/data.json');
      expect(result.kind).toBe('text');
    });

    it('treats extensionless Dockerfile as text', async () => {
      mockStatSize(26);
      mockFileRead('FROM node:20-alpine\nRUN npm i');

      const result = await invoke('/tmp/Dockerfile');
      expect(result.kind).toBe('text');
    });

    it('treats unknown extensions as text when contents are textual', async () => {
      mockStatSize(18);
      mockFileRead('tasks.register()');

      const result = await invoke('/tmp/build.gradle');
      expect(result.kind).toBe('text');
    });

    it('treats unknown extensions as unsupported when contents contain null bytes', async () => {
      mockStatSize(18);
      mockBinaryFileRead();

      const result = await invoke('/tmp/build.gradle');
      expect(result.kind).toBe('unsupported');
      expect(result.content).toBe('');
    });
  });

  describe('image size limit', () => {
    it('returns unsupported for images over 5MB', async () => {
      mockStatSize(6 * 1024 * 1024);

      const result = await invoke('/tmp/huge.png');
      expect(result.kind).toBe('unsupported');
      expect(result.content).toBe('');
      expect(result.truncated).toBe(false);
    });

    it('returns image data for images under 5MB', async () => {
      mockStatSize(100);
      mockedReadFile.mockResolvedValue(Buffer.from('PNG'));

      const result = await invoke('/tmp/small.png');
      expect(result.kind).toBe('image');
      expect(result.content).toMatch(/^data:image\/png;base64,/);
    });
  });

  describe('video first frame', () => {
    it('answers an opted-in video with the OS thumbnail of its first frame', async () => {
      mockStatSize(4096);
      mockCreateThumbnailFromPath.mockResolvedValue({
        isEmpty: () => false,
        toDataURL: () => 'data:image/png;base64,FRAME',
      });

      const result = await invoke('/tmp/demo.MP4', { videoFrame: true });
      expect(result).toMatchObject({
        kind: 'image',
        content: 'data:image/png;base64,FRAME',
        filename: 'demo.MP4',
      });
      expect(mockCreateThumbnailFromPath).toHaveBeenCalledWith(
        '/tmp/demo.MP4',
        { width: 96, height: 96 },
      );
    });

    it('keeps a video unsupported unless the caller opts in', async () => {
      mockStatSize(4096);

      const result = await invoke('/tmp/demo.mp4');
      expect(result.kind).not.toBe('image');
      expect(mockCreateThumbnailFromPath).not.toHaveBeenCalled();
    });

    it('stays unsupported where the OS has no thumbnail', async () => {
      mockStatSize(4096);
      mockCreateThumbnailFromPath.mockRejectedValueOnce(
        new Error('unsupported platform'),
      );
      expect((await invoke('/tmp/demo.mov', { videoFrame: true })).kind).toBe(
        'unsupported',
      );

      mockCreateThumbnailFromPath.mockResolvedValueOnce({
        isEmpty: () => true,
        toDataURL: () => '',
      });
      expect((await invoke('/tmp/demo.webm', { videoFrame: true })).kind).toBe(
        'unsupported',
      );
    });

    it('never thumbnails a file that is not a video', async () => {
      mockStatSize(100);
      mockedReadFile.mockResolvedValue(Buffer.from('PNG'));

      const result = await invoke('/tmp/small.png', { videoFrame: true });
      expect(result.content).toMatch(/^data:image\/png;base64,/);
      expect(mockCreateThumbnailFromPath).not.toHaveBeenCalled();
    });
  });

  describe('binary detection', () => {
    it('returns unsupported when text file contains null bytes', async () => {
      mockStatSize(100);
      mockBinaryFileRead();

      const result = await invoke('/tmp/file.txt');
      expect(result.kind).toBe('unsupported');
      expect(result.content).toBe('');
    });
  });

  describe('truncation', () => {
    it('sets truncated to true when file exceeds 2048 bytes', async () => {
      mockStatSize(3000);
      mockFileRead('x'.repeat(2048));

      const result = await invoke('/tmp/big.ts');
      expect(result.truncated).toBe(true);
    });

    it('sets truncated to false when file fits within 2048 bytes', async () => {
      mockStatSize(100);
      mockFileRead('small content');

      const result = await invoke('/tmp/small.ts');
      expect(result.truncated).toBe(false);
    });

    it('sets truncated to false for unsupported files', async () => {
      mockStatSize(5000);

      const result = await invoke('/tmp/archive.zip');
      expect(result.truncated).toBe(false);
    });

    it('sets truncated to false for images', async () => {
      mockStatSize(1000);
      mockedReadFile.mockResolvedValue(Buffer.from('GIF89a'));

      const result = await invoke('/tmp/anim.gif');
      expect(result.truncated).toBe(false);
    });
  });

  describe('response shape', () => {
    it('includes filename extracted from path', async () => {
      mockStatSize(10);
      mockFileRead('hello');

      const result = await invoke('/some/deep/path/myfile.txt');
      expect(result.filename).toBe('myfile.txt');
    });

    it('includes sizeBytes from stat', async () => {
      mockStatSize(42);
      mockFileRead('data');

      const result = await invoke('/tmp/test.txt');
      expect(result.sizeBytes).toBe(42);
    });

    it('includes modifiedAtMs from stat', async () => {
      mockStatSize(42, 1700000000123);
      mockFileRead('data');

      const result = await invoke('/tmp/test.txt');
      expect(result.modifiedAtMs).toBe(1700000000123);
    });

    it('returns correct MIME for jpeg', async () => {
      mockStatSize(50);
      mockedReadFile.mockResolvedValue(Buffer.from('JPEG'));

      const result = await invoke('/tmp/photo.jpg');
      expect(result.content).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('returns correct MIME for svg', async () => {
      mockStatSize(50);
      mockedReadFile.mockResolvedValue(Buffer.from('<svg>'));

      const result = await invoke('/tmp/icon.svg');
      expect(result.content).toMatch(/^data:image\/svg\+xml;base64,/);
    });
  });
});

describe('fileOpenExternal handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerFilePreviewHandlers(
      unusedFileContentDispatcher,
      unusedCallerResolver,
    );
  });

  it('escapes reserved characters in local file URLs', async () => {
    mockedRealpath.mockImplementation(
      (value): Promise<string> => Promise.resolve(String(value)),
    );

    await getHandler(IPC_CHANNELS.fileOpenExternal)(undefined, {
      absolutePath: '/tmp/report#draft?v=1.html',
    });

    // Separates "never reached openExternalGuarded" from "took the E2E branch".
    expect(mockIsE2eBuild).toHaveBeenCalledTimes(1);
    expect(mockOpenExternal).toHaveBeenCalledWith(
      'file:///tmp/report%23draft%3Fv=1.html',
    );
  });

  it('rejects an unscoped path inside the sealed replica store', async () => {
    mockedRealpath.mockImplementation(
      (value): Promise<string> => Promise.resolve(String(value)),
    );

    await expect(
      getHandler(IPC_CHANNELS.fileOpenExternal)(undefined, {
        absolutePath:
          '/canopy-data/shared-containers/container-1/revisions/rev-1/content/repositories/repo-1/index.html',
      }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });
});

describe('fileShowInFinder handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerFilePreviewHandlers(
      unusedFileContentDispatcher,
      unusedCallerResolver,
    );
  });

  it('rejects Windows UNC and device paths', async () => {
    const invoke = getHandler(IPC_CHANNELS.fileShowInFinder);

    await expect(
      invoke(undefined, { absolutePath: '\\\\attacker.example\\share\\x.txt' }),
    ).rejects.toThrow('network and device paths are not allowed');
    await expect(
      invoke(undefined, { absolutePath: '\\\\?\\C:\\repo\\x.txt' }),
    ).rejects.toThrow('network and device paths are not allowed');
    expect(mockShowItemInFolder).not.toHaveBeenCalled();
  });

  it('requires both worktree scope ids together', async () => {
    await expect(
      getHandler(IPC_CHANNELS.fileShowInFinder)(undefined, {
        absolutePath: '/repo/file.ts',
        projectId: 'project-1',
      }),
    ).rejects.toThrow('projectId and worktreeId must be provided together');
  });

  it('canonicalizes and permits targets inside a scoped file root', async () => {
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots: [
        {
          repoId: 'project-1',
          repoName: 'project-1',
          absolutePath: '/repo',
          rootKind: 'git-repo',
          gitAware: true,
          excludedDescendantRoots: [],
        },
      ],
      rootMap: new Map(),
    });
    mockedRealpath.mockImplementation((pathValue) =>
      Promise.resolve(
        String(pathValue) === '/repo/file-link.ts'
          ? '/repo/src/file.ts'
          : String(pathValue),
      ),
    );

    await getHandler(IPC_CHANNELS.fileShowInFinder)(undefined, {
      absolutePath: '/repo/file-link.ts',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });

    expect(mockShowItemInFolder).toHaveBeenCalledWith('/repo/src/file.ts');
  });

  it('rejects scoped targets outside the worktree roots', async () => {
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots: [
        {
          repoId: 'project-1',
          repoName: 'project-1',
          absolutePath: '/repo',
          rootKind: 'git-repo',
          gitAware: true,
          excludedDescendantRoots: [],
        },
      ],
      rootMap: new Map(),
    });
    mockedRealpath.mockImplementation((pathValue) =>
      Promise.resolve(String(pathValue)),
    );

    await expect(
      getHandler(IPC_CHANNELS.fileShowInFinder)(undefined, {
        absolutePath: '/tmp/outside.txt',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    ).rejects.toThrow('target must be inside the active worktree');
    expect(mockShowItemInFolder).not.toHaveBeenCalled();
  });

  it('preserves trusted unscoped local reveal requests', async () => {
    await getHandler(IPC_CHANNELS.fileShowInFinder)(undefined, {
      absolutePath: '/tmp/feedback.zip',
    });

    expect(mockShowItemInFolder).toHaveBeenCalledWith('/tmp/feedback.zip');
  });

  it('rejects an unscoped path inside the sealed replica store', async () => {
    mockedRealpath.mockImplementation(
      (value): Promise<string> => Promise.resolve(String(value)),
    );

    await expect(
      getHandler(IPC_CHANNELS.fileShowInFinder)(undefined, {
        absolutePath:
          '/canopy-data/shared-containers/container-1/revisions/rev-1/content/repositories/repo-1/index.html',
      }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');
    expect(mockShowItemInFolder).not.toHaveBeenCalled();
  });
});

describe('fileReferenceResolve handler', () => {
  const fileStats = statSync(__filename);
  const directoryStats = statSync(__dirname);
  // The handler projects over `worker.filesystem.link.resolve` (CAN-5038).
  let runtime: DesktopCanopyDispatcher | undefined;

  function invoke(baseFilePath: string, href: string): Promise<unknown> {
    return getHandler(IPC_CHANNELS.fileReferenceResolve)(
      { sender: { id: 7 } },
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        baseFilePath,
        href,
      },
    );
  }

  afterEach(async () => {
    await runtime?.shutdown();
    runtime = undefined;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedStat.mockResolvedValue(fileStats);
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots: [
        {
          repoId: 'project-1',
          repoName: 'project-1',
          absolutePath: '/repo',
          rootKind: 'git-repo',
          gitAware: true,
          excludedDescendantRoots: [],
        },
      ],
      rootMap: new Map(),
    });
    mockedRealpath.mockImplementation((pathValue) => {
      const normalized = String(pathValue);
      if (normalized === '/repo' || normalized.startsWith('/repo/')) {
        return Promise.resolve(normalized);
      }
      return Promise.reject(new Error('ENOENT'));
    });
    runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
    registerFilePreviewHandlers(runtime, (event) => ({
      principalId: 'local',
      clientInstanceId: `electron-web-contents:${event.sender.id}`,
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'desktop',
      grants: ['worker.filesystem.read'],
    }));
  });

  it('resolves markdown-relative links inside allowed roots', async () => {
    await expect(
      invoke('/repo/docs/readme.md', '../ignored-output.txt'),
    ).resolves.toEqual({
      absolutePath: '/repo/ignored-output.txt',
      filename: 'ignored-output.txt',
      kind: 'file',
    });
  });

  it('preserves a projected UNC root when resolving a file reference', async () => {
    const uncRoot = '//server/share/project';
    const uncFile = `${uncRoot}/report.md`;
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots: [
        {
          repoId: 'project-1',
          repoName: 'project-1',
          absolutePath: uncRoot,
          rootKind: 'git-repo',
          gitAware: true,
          excludedDescendantRoots: [],
        },
      ],
      rootMap: new Map(),
    });
    mockedRealpath.mockImplementation((pathValue) =>
      String(pathValue) === uncFile || String(pathValue) === uncRoot
        ? Promise.resolve(String(pathValue))
        : Promise.reject(new Error('ENOENT')),
    );

    await expect(invoke(uncFile, 'report.md')).resolves.not.toBeNull();
    expect(mockedRealpath).toHaveBeenCalledWith(uncFile);
  });

  it('identifies directory links so the renderer does not read them as files', async () => {
    mockedStat.mockResolvedValue(directoryStats);

    await expect(invoke('/repo/README.md', './evaluations')).resolves.toEqual({
      absolutePath: '/repo/evaluations',
      filename: 'evaluations',
      kind: 'directory',
    });
  });

  it('returns null when the resolved target cannot be inspected', async () => {
    mockedStat.mockRejectedValue(new Error('ENOENT'));

    await expect(
      invoke('/repo/docs/readme.md', '../removed-output.txt'),
    ).resolves.toBeNull();
  });

  it('returns a root-aligned presentation path after authorizing a symlinked root', async () => {
    mockedRealpath.mockImplementation((pathValue) =>
      Promise.resolve(
        String(pathValue).replace(/^\/repo(?=\/|$)/, '/private/repo'),
      ),
    );
    await expect(
      invoke('/repo/docs/readme.md', './report.md'),
    ).resolves.toEqual({
      absolutePath: '/repo/docs/report.md',
      filename: 'report.md',
      kind: 'file',
    });
    await expect(
      invoke('/repo/docs/readme.md', '/private/repo/docs/report.md'),
    ).resolves.toEqual({
      absolutePath: '/repo/docs/report.md',
      filename: 'report.md',
      kind: 'file',
    });
    await expect(
      invoke('/repo/docs/readme.md', '/private/outside/report.md'),
    ).resolves.toBeNull();
  });

  it('resolves percent-encoded links', async () => {
    await expect(
      invoke('/repo/docs/readme.md', './space%20file.md'),
    ).resolves.toEqual({
      absolutePath: '/repo/docs/space file.md',
      filename: 'space file.md',
      kind: 'file',
    });
  });

  it('resolves absolute image paths inside a managed attachments root', async () => {
    const attachmentPath =
      '/workspace/home/.canopy/attachments/markdown-preview.png';
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots: [
        {
          repoId: 'attachments',
          repoName: 'attachments',
          absolutePath: '/workspace/home/.canopy/attachments',
          rootKind: 'attachments',
          gitAware: false,
          excludedDescendantRoots: [],
        },
      ],
      rootMap: new Map(),
    });
    mockedRealpath.mockImplementation((pathValue) =>
      Promise.resolve(String(pathValue)),
    );

    await expect(
      invoke('/workspace/home/README.md', attachmentPath),
    ).resolves.toEqual({
      absolutePath: attachmentPath,
      filename: 'markdown-preview.png',
      kind: 'file',
    });
  });

  it('resolves repo-prefixed links against sibling roots', async () => {
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots: [
        {
          repoId: 'app',
          repoName: 'app',
          absolutePath: '/workspace/app',
          rootKind: 'git-repo',
          gitAware: true,
          excludedDescendantRoots: [],
        },
        {
          repoId: 'api',
          repoName: 'api',
          absolutePath: '/workspace/api',
          rootKind: 'git-repo',
          gitAware: true,
          excludedDescendantRoots: [],
        },
      ],
      rootMap: new Map(),
    });
    mockedRealpath.mockImplementation((pathValue) => {
      const normalized = String(pathValue);
      if (
        normalized === '/workspace/app' ||
        normalized === '/workspace/api' ||
        normalized.startsWith('/workspace/app/') ||
        normalized.startsWith('/workspace/api/')
      ) {
        return Promise.resolve(normalized);
      }
      return Promise.reject(new Error('ENOENT'));
    });

    await expect(
      invoke(
        '/workspace/app/docs/readme.md',
        'api/docs/space%20file.md#section',
      ),
    ).resolves.toEqual({
      absolutePath: '/workspace/api/docs/space file.md',
      filename: 'space file.md',
      kind: 'file',
    });
  });

  it('returns null for mailto links and fragments', async () => {
    await expect(
      invoke('/repo/docs/readme.md', 'mailto:test@example.com'),
    ).resolves.toBeNull();
    await expect(
      invoke('/repo/docs/readme.md', '#section'),
    ).resolves.toBeNull();
  });

  it('returns null for paths outside allowed roots', async () => {
    await expect(
      invoke('/repo/docs/readme.md', '../../outside.txt'),
    ).resolves.toBeNull();
  });

  it('returns null for .git paths and symlink escapes', async () => {
    mockedRealpath.mockImplementation((pathValue) => {
      const normalized = String(pathValue);
      if (normalized === '/repo') {
        return Promise.resolve('/repo');
      }
      if (normalized === '/repo/link.md') {
        return Promise.resolve('/outside/link.md');
      }
      return Promise.resolve(normalized);
    });

    await expect(
      invoke('/repo/docs/readme.md', '../.git/config'),
    ).resolves.toBeNull();
    await expect(
      invoke('/repo/docs/readme.md', '../link.md'),
    ).resolves.toBeNull();
  });
});

describe('fileUrlToAbsolutePath', () => {
  it('normalizes Windows drive-letter file URLs', () => {
    expect(
      fileUrlToAbsolutePath(new URL('file:///C:/repo/docs/readme.md')),
    ).toBe('C:/repo/docs/readme.md');
  });
});

describe('fileReadDocumentBytes handler', () => {
  const maxBytes = 25 * 1024 * 1024;
  const target = { projectId: 'project-1', worktreeId: 'worktree-1' };
  const actualFs = jest.requireActual<typeof FsPromises>('node:fs/promises');
  let directory: string;
  let handle: FileHandle;
  type DocumentHandleSpies = {
    [Key in 'stat' | 'read' | 'close']: jest.SpyInstance<
      ReturnType<FileHandle[Key]>,
      Parameters<FileHandle[Key]>
    >;
  };
  let handleSpies: DocumentHandleSpies;
  function spyOnDocumentHandle(file: FileHandle): DocumentHandleSpies {
    return {
      stat: jest.spyOn(file, 'stat').mockResolvedValue(metadata),
      read: jest.spyOn(file, 'read'),
      close: jest.spyOn(file, 'close').mockResolvedValue(undefined),
    };
  }
  let metadata: Stats;
  let closeHandle: () => Promise<void>;
  const invoke = async (
    absolutePath = '/workspace/brief.pdf',
  ): Promise<FileDocumentBytesResponse> => {
    const registration = jest
      .mocked(
        registerIpcHandler<
          [FileDocumentBytesRequest],
          FileDocumentBytesResponse
        >,
      )
      .mock.calls.find(([channel]) => channel === 'file:read-document-bytes');
    if (!registration)
      throw new Error('Document byte handler was not registered');
    return registration[1](documentInvokeEvent, {
      absolutePath,
      workspaceTarget: target,
    });
  };

  function contents(bytes: Buffer, shortRead = 65536): void {
    handleSpies.read.mockImplementation(
      (...args: unknown[]): Promise<{ bytesRead: number; buffer: Buffer }> => {
        const [buffer, offset, length, position] = args;
        if (
          !Buffer.isBuffer(buffer) ||
          typeof offset !== 'number' ||
          typeof length !== 'number' ||
          typeof position !== 'number'
        ) {
          throw new Error('Expected a buffered read with explicit offsets');
        }
        const bytesRead = Math.max(
          0,
          Math.min(length, shortRead, bytes.length - position),
        );
        bytes.copy(buffer, offset, position, position + bytesRead);
        return Promise.resolve({ bytesRead, buffer });
      },
    );
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    registerFilePreviewHandlers(
      unusedFileContentDispatcher,
      unusedCallerResolver,
    );
    directory = await actualFs.mkdtemp(path.join(os.tmpdir(), 'pdf-bytes-'));
    handle = await actualFs.open(path.join(directory, 'brief.pdf'), 'w+');
    closeHandle = handle.close.bind(handle);
    metadata = statSync(path.join(directory, 'brief.pdf'));
    metadata.size = 3;
    metadata.mtimeMs = 123;
    handleSpies = spyOnDocumentHandle(handle);
    mockedOpen.mockResolvedValue(handle);
    jest
      .mocked(lstat)
      .mockImplementation(() =>
        Promise.resolve(Object.assign(statSync(directory), metadata)),
      );
    mockedRealpath.mockImplementation((value) =>
      Promise.resolve(String(value)),
    );
    mockedGetFileBrowserRoots.mockResolvedValue(documentRoots('/workspace'));
    contents(Buffer.from([0, 255, 42]));
  });

  afterEach(async () => {
    await closeHandle();
    await actualFs.rm(directory, { recursive: true, force: true });
  });

  it('returns byte-exact owned bytes and closes the handle', async () => {
    const result = await invoke();
    expect(result).toEqual({
      status: 'ready',
      bytes: new Uint8Array([0, 255, 42]),
      filename: 'brief.pdf',
      sizeBytes: 3,
      modifiedAtMs: 123,
    });
    expect(handleSpies.close).toHaveBeenCalledTimes(1);
  });

  it.each([0, maxBytes])('accepts a %i byte document', async (length) => {
    metadata.size = length;
    contents(Buffer.alloc(length, 17));
    const result = await invoke();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected ready document');
    expect(result.sizeBytes).toBe(length);
    expect(result.bytes.byteLength).toBe(length);
    expect(result.bytes.buffer.byteLength).toBe(length);
    expect(handleSpies.close).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized stat before reading', async () => {
    metadata.size = maxBytes + 10;
    expect(await invoke()).toEqual({
      status: 'too-large',
      maxBytes,
      sizeBytes: maxBytes + 10,
    });
    expect(handleSpies.read).not.toHaveBeenCalled();
    expect(handleSpies.close).toHaveBeenCalledTimes(1);
  });

  it('gives video files the larger video budget (CAN-3995)', async () => {
    const videoMaxBytes = 100 * 1024 * 1024;
    metadata.size = maxBytes + 1;
    contents(Buffer.alloc(maxBytes + 1, 17));
    const ready = await invoke('/workspace/reel.mp4');
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') throw new Error('Expected ready video');
    expect(ready.sizeBytes).toBe(maxBytes + 1);

    metadata.size = videoMaxBytes + 1;
    expect(await invoke('/workspace/reel.mp4')).toEqual({
      status: 'too-large',
      maxBytes: videoMaxBytes,
      sizeBytes: videoMaxBytes + 1,
    });
  });

  it('bounds growing files to the limit plus one observed byte', async () => {
    contents(Buffer.alloc(maxBytes + 100, 17));
    expect(await invoke()).toEqual({
      status: 'too-large',
      maxBytes,
      sizeBytes: maxBytes + 1,
    });
    expect(
      handleSpies.read.mock.calls.every(
        (call: unknown[]) => typeof call[2] === 'number' && call[2] <= 65536,
      ),
    ).toBe(true);
    expect(handleSpies.close).toHaveBeenCalledTimes(1);
  });

  it('continues after short reads until EOF', async () => {
    contents(Buffer.from([1, 2, 3, 4, 5]), 2);
    expect(await invoke()).toMatchObject({
      status: 'ready',
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      sizeBytes: 5,
    });
    expect(handleSpies.close).toHaveBeenCalledTimes(1);
  });

  it('maps ENOENT to missing before open', async () => {
    mockedRealpath.mockRejectedValue(
      Object.assign(new Error('gone'), { code: 'ENOENT' }),
    );
    expect(await invoke()).toEqual({ status: 'missing' });
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it('rejects permission failure without opening', async () => {
    jest
      .mocked(lstat)
      .mockRejectedValue(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );
    await expect(invoke()).rejects.toThrow('denied');
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it('closes after a read error', async () => {
    handleSpies.read.mockRejectedValue(new Error('read failed'));
    await expect(invoke()).rejects.toThrow('read failed');
    expect(handleSpies.close).toHaveBeenCalledTimes(1);
  });

  it('requires project scope', async () => {
    await expect(
      getHandler('file:read-document-bytes')(documentInvokeEvent, {
        absolutePath: '/workspace/brief.pdf',
        workspaceTarget: null,
      }),
    ).rejects.toThrow(/project target/i);
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it.each(['/outside/brief.pdf', '/workspace-other/brief.pdf'])(
    'rejects outside root %s before open',
    async (file) => {
      await expect(invoke(file)).rejects.toThrow(/outside/);
      expect(mockedOpen).not.toHaveBeenCalled();
    },
  );

  it('rejects a symlink escape before open', async () => {
    mockedRealpath.mockImplementation((value) =>
      Promise.resolve(
        String(value).endsWith('.pdf') ? '/outside/secret.pdf' : String(value),
      ),
    );
    await expect(invoke()).rejects.toThrow(/outside/);
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it('rejects a parent symlink swapped after containment and closes without reading', async () => {
    let fileResolutions = 0;
    mockedRealpath.mockImplementation((value) => {
      const file = String(value);
      if (file.endsWith('.pdf') && ++fileResolutions > 1)
        return Promise.resolve('/outside/brief.pdf');
      return Promise.resolve(file);
    });
    await expect(invoke()).rejects.toThrow(/outside/);
    expect(handleSpies.read).not.toHaveBeenCalled();
    expect(handleSpies.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed inode and closes', async () => {
    handleSpies.stat.mockResolvedValue(
      Object.assign(statSync(directory), metadata, { ino: 99 }),
    );
    await expect(invoke()).rejects.toThrow(/changed/);
    expect(handleSpies.read).not.toHaveBeenCalled();
    expect(handleSpies.close).toHaveBeenCalledTimes(1);
  });

  it('rejects nonregular targets before open', async () => {
    metadata.isFile = (): boolean => false;
    await expect(invoke()).rejects.toThrow(/regular file/);
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it('rejects a nonregular target raced into open and closes', async () => {
    handleSpies.stat.mockResolvedValue(
      Object.assign(statSync(directory), metadata, { isFile: () => false }),
    );
    await expect(invoke()).rejects.toThrow(/regular file/);
    expect(handleSpies.read).not.toHaveBeenCalled();
    expect(handleSpies.close).toHaveBeenCalledTimes(1);
  });
});
