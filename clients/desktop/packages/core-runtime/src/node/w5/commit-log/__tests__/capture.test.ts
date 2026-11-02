import {
  constants,
  promises as fs,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { W5CommitLog, fingerprintW5File } from '../commit-log';
import { captureW5Files } from '../capture';
import { anchorW5CaptureRoot } from '../data-root';
import {
  W5_CAPTURE_LIMITS,
  isW5CaptureRequest,
  isW5CaptureResult,
  type W5CaptureRequest,
  type W5CaptureResult,
  type W5ConfinedFileRead,
  type W5ConfinedFileReader,
} from '../capture-contract';
import {
  W5CommitLogRequestHandler,
  toW5CommitLogWorkerError,
} from '../worker-requests';

let dir: string;
let root: string;
let dbPath: string;
let log: W5CommitLog;
const request: W5CaptureRequest = {
  files: [{ kind: 'index' }],
  discoverWorkspaces: true,
};
const durability = { syncDirectory: jest.fn(), writeFileDurably: jest.fn() };
const recovery = {
  applied: [],
  recoveryRequired: [],
  interruptedReservations: 0,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-capture-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  dbPath = join(dir, 'log.sqlite');
  log = W5CommitLog.open(dbPath);
  jest.clearAllMocks();
});
afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});
function capture(input: W5CaptureRequest = request): Promise<W5CaptureResult> {
  return captureW5Files(log, root, input, process.platform);
}
function index(contents: string | Buffer): void {
  writeFileSync(join(root, 'index.json'), contents);
}
function disk(): Record<string, Buffer> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name !== 'workspaces')
      .map((name) => [name, readFileSync(join(dir, name))]),
  );
}

it('captures lossless bytes (including invalid UTF-8), missing files and empty requests', async () => {
  const bytes = Buffer.from([0, 255, 254, 10]);
  index(bytes);
  const result = await capture({
    files: [{ kind: 'index' }, { kind: 'index-backup' }],
    discoverWorkspaces: true,
  });
  expect(result.files).toEqual([
    { kind: 'index', state: 'present', base64: bytes.toString('base64') },
    { kind: 'index-backup', state: 'absent' },
  ]);
  expect(result.discovery).toBe('invalid-index');
  expect(isW5CaptureResult(result)).toBe(true);
  expect(Object.isFrozen(result.files[0])).toBe(true);
  expect(Object.isFrozen(result.log.revisions)).toBe(true);
  expect(
    (await capture({ files: [], discoverWorkspaces: false })).files,
  ).toEqual([]);
  index('');
  expect((await capture()).files[0]).toMatchObject({
    state: 'present',
    base64: '',
  });
});

it('discovers and deduplicates workspace files from the captured index without normalizing their bytes', async () => {
  index('{"workspaces":[{"id":"alpha"},{"id":"alpha"}]}');
  mkdirSync(join(root, 'alpha'));
  writeFileSync(join(root, 'alpha', 'workspace.json'), ' {broken json\n');
  const result = await capture({
    files: [{ kind: 'manifest', workspaceId: 'alpha' }],
    discoverWorkspaces: true,
  });
  expect(result.discovery).toBe('complete');
  expect(result.files).toHaveLength(3);
  expect(result.files[1]).toMatchObject({
    state: 'present',
    base64: Buffer.from(' {broken json\n').toString('base64'),
  });
  expect(result.files[2]).toMatchObject({ kind: 'worktrees', state: 'absent' });
});

it.each([
  '..',
  '../escape',
  '/absolute',
  'a/b',
  'a\\b',
  'a:b',
  'NUL',
  'a.',
  '',
  'alpha\n',
  'alpha\r',
  'alpha\u2028',
  'alpha\u2029',
  'x'.repeat(129),
])('rejects unsafe request and discovered ID %p', async (workspaceId) => {
  expect(
    isW5CaptureRequest({
      files: [{ kind: 'manifest', workspaceId }],
      discoverWorkspaces: false,
    }),
  ).toBe(false);
  index(JSON.stringify({ workspaces: [{ id: workspaceId }] }));
  const result = await capture();
  expect(result.discovery).toBe('invalid-index');
  expect(result.files).toHaveLength(1);
});

it.each([
  undefined,
  {},
  { files: [], discoverWorkspaces: 'yes' },
  {
    files: [{ kind: 'arbitrary', path: '/secret' }],
    discoverWorkspaces: false,
  },
  { files: [], discoverWorkspaces: false, root: '/escape' },
  { files: [], discoverWorkspaces: false, platform: 'darwin' },
  {
    files: Array.from({ length: 257 }, () => ({ kind: 'index' })),
    discoverWorkspaces: false,
  },
])('rejects malformed capture requests at the worker', async (input) => {
  const handler = new W5CommitLogRequestHandler(
    log,
    { root, dbPath },
    recovery,
    durability,
    process.platform,
  );
  await expect(
    handler
      .run({ id: 1, method: 'capture', args: [input] })
      .catch((error: unknown) => {
        return toW5CommitLogWorkerError(error);
      }),
  ).resolves.toMatchObject({ kind: 'malformed' });
});

it('rejects extra worker arguments', async () => {
  const handler = new W5CommitLogRequestHandler(
    log,
    { root, dbPath },
    recovery,
    durability,
    process.platform,
  );
  await expect(
    handler.run({ id: 1, method: 'capture', args: [request, {}] }),
  ).rejects.toThrow('malformed');
});

it('does not follow final symlinks, dangling symlinks or a workspace directory escape', async () => {
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'workspace.json'), 'secret');
  symlinkSync(join(outside, 'workspace.json'), join(root, 'index.json'));
  symlinkSync(join(outside, 'missing'), join(root, 'index.json.bak'));
  symlinkSync(outside, join(root, 'alpha'), 'junction');
  const result = await capture({
    files: [
      { kind: 'index' },
      { kind: 'index-backup' },
      { kind: 'manifest', workspaceId: 'alpha' },
    ],
    discoverWorkspaces: false,
  });
  expect(result.files.map((file) => file.state)).toEqual([
    'unreadable',
    'unreadable',
    'unreadable',
  ]);
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('reports non-files and permission failures as unreadable, not absent', async () => {
  mkdirSync(join(root, 'index.json'));
  expect((await capture()).files[0]).toMatchObject({
    state: 'unreadable',
    reason: 'not-file',
  });
  rmSync(join(root, 'index.json'), { recursive: true });
  index('private');
  const denied = jest
    .spyOn(fs, 'open')
    .mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
  try {
    expect((await capture()).files[0]).toMatchObject({
      state: 'unreadable',
      reason: 'io',
    });
  } finally {
    denied.mockRestore();
  }
});

const unsupportedPlatforms: readonly (NodeJS.Platform | null)[] = [
  'freebsd',
  null,
];

it.each(['stat', 'read', 'close'] as const)(
  'reports a descriptor %s failure as unreadable, even for ENOENT',
  async (operation) => {
    index('present but unreadable');
    const originalOpen = fs.open;
    let closed = (): number => 0;
    const opened = jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        const originalClose = handle.close.bind(handle);
        const close = jest
          .spyOn(handle, 'close')
          .mockImplementation(async () => {
            await originalClose();
            if (operation === 'close')
              throw Object.assign(new Error('close failed'), {
                code: 'ENOENT',
              });
          });
        closed = (): number => close.mock.calls.length;
        if (operation === 'stat')
          jest
            .spyOn(handle, 'stat')
            .mockRejectedValueOnce(
              Object.assign(new Error('descriptor failed'), { code: 'ENOENT' }),
            );
        if (operation === 'read') {
          const originalRead = handle.read.bind(handle);
          jest
            .spyOn(handle, 'read')
            .mockImplementationOnce((...readArgs) => originalRead(...readArgs))
            .mockRejectedValueOnce(
              Object.assign(new Error('partial read failed'), {
                code: 'ENOENT',
              }),
            );
        }
        return handle;
      });
    try {
      const result = await capture();
      expect(result.files).toEqual([
        { kind: 'index', state: 'unreadable', reason: 'io' },
      ]);
      expect(result.discovery).toBe('unavailable');
      expect(closed()).toBe(1);
      expect(isW5CaptureResult(result)).toBe(true);
    } finally {
      opened.mockRestore();
    }
  },
);

it.each(['stat', 'read', 'limit'] as const)(
  'preserves a %s failure when closing the descriptor also fails',
  async (operation) => {
    index(
      operation === 'limit'
        ? Buffer.alloc(W5_CAPTURE_LIMITS.bytes + 1)
        : 'present but unreadable',
    );
    const originalOpen = fs.open;
    let closeCount = (): number => 0;
    const opened = jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        const originalClose = handle.close.bind(handle);
        const close = jest
          .spyOn(handle, 'close')
          .mockImplementation(async () => {
            await originalClose();
            throw Object.assign(new Error('close failed'), { code: 'EACCES' });
          });
        closeCount = (): number => close.mock.calls.length;
        if (operation === 'stat')
          jest
            .spyOn(handle, 'stat')
            .mockRejectedValueOnce(
              Object.assign(new Error('descriptor failed'), { code: 'ENOENT' }),
            );
        if (operation === 'read') {
          const originalRead = handle.read.bind(handle);
          jest
            .spyOn(handle, 'read')
            .mockImplementationOnce((...readArgs) => originalRead(...readArgs))
            .mockRejectedValueOnce(
              Object.assign(new Error('partial read failed'), {
                code: 'ENOENT',
              }),
            );
        }
        return handle;
      });
    try {
      if (operation === 'limit') {
        await expect(capture()).rejects.toMatchObject({
          reason: 'invalid-state',
          details: { capture: 'limit-exceeded' },
        });
      } else {
        const result = await capture();
        expect(result.files).toEqual([
          { kind: 'index', state: 'unreadable', reason: 'io' },
        ]);
        expect(result.discovery).toBe('unavailable');
        expect(JSON.stringify(result)).not.toContain('present but unreadable');
      }
      expect(closeCount()).toBe(1);
    } finally {
      opened.mockRestore();
    }
  },
);

const unavailableConfinement: readonly [
  string,
  (() => W5ConfinedFileReader | null) | undefined,
][] = [
  ['no reader source', undefined],
  ['a reader source without a reader', (): null => null],
  [
    'a reader source that throws',
    (): never => {
      throw new Error('addon failed to load');
    },
  ],
];

it.each([
  ...unsupportedPlatforms.map(
    (platform) =>
      [String(platform), platform, undefined, 'unsupported-platform'] as const,
  ),
  ...unavailableConfinement.map(
    ([name, source]) =>
      [
        `win32 with ${name}`,
        'win32',
        source,
        'confinement-unavailable',
      ] as const,
  ),
])(
  'refuses capture on %s before accessing files or log evidence',
  async (_name, platform, source, refusal) => {
    const opened = jest.spyOn(fs, 'open');
    const resolved = jest.spyOn(fs, 'realpath');
    const evidence = jest.spyOn(log, 'captureEvidence');
    const handler = new W5CommitLogRequestHandler(
      log,
      { dbPath, root },
      recovery,
      durability,
      platform,
      source,
    );
    try {
      for (const input of [request, { files: [], discoverWorkspaces: false }]) {
        const result = await handler
          .run({ id: 1, method: 'capture', args: [input] })
          .catch(toW5CommitLogWorkerError);
        expect(result).toMatchObject({
          kind: 'refused',
          reason: 'invalid-state',
          details: { capture: refusal },
        });
      }
      expect(opened).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
      expect(evidence).not.toHaveBeenCalled();
      expect(durability.syncDirectory).not.toHaveBeenCalled();
      expect(durability.writeFileDurably).not.toHaveBeenCalled();
    } finally {
      opened.mockRestore();
      resolved.mockRestore();
      evidence.mockRestore();
    }
  },
);

it.each(['darwin', 'linux', 'win32'] as const)(
  'refuses a data root that does not resolve as typed on %s, keeping the worker',
  async (platform) => {
    rmSync(root, { recursive: true });
    const read = jest.fn(() =>
      Promise.resolve<W5ConfinedFileRead>({ state: 'absent' }),
    );
    const confined: W5ConfinedFileReader = { read };
    const evidence = jest.spyOn(log, 'captureEvidence');
    const handler = new W5CommitLogRequestHandler(
      log,
      { dbPath, root },
      recovery,
      durability,
      platform,
      () => confined,
    );
    try {
      const refused = await handler
        .run({ id: 1, method: 'capture', args: [request] })
        .catch(toW5CommitLogWorkerError);
      // `refused`, not `failed`: a `failed` capture retires the host's worker.
      expect(refused).toEqual({
        kind: 'refused',
        reason: 'invalid-state',
        message: 'The W5 data root could not be resolved.',
        details: { capture: 'root-unavailable', code: 'ENOENT' },
      });
      expect(read).not.toHaveBeenCalled();
      expect(evidence).not.toHaveBeenCalled();
    } finally {
      evidence.mockRestore();
    }
  },
);

describe('Windows capture through the host reader (CAN-5202)', () => {
  type Call = { root: string; components: string[]; maxBytes: number };
  function reader(results: Record<string, W5ConfinedFileRead | Error>): {
    source: () => W5ConfinedFileReader;
    calls: Call[];
  } {
    const calls: Call[] = [];
    const confined: W5ConfinedFileReader = {
      read: (readRoot, components, maxBytes) => {
        calls.push({ root: readRoot, components: [...components], maxBytes });
        const result = results[components.join('/')] ?? { state: 'absent' };
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result);
      },
    };
    return { source: () => confined, calls };
  }
  const present = (bytes: string | Uint8Array): W5ConfinedFileRead => ({
    state: 'present',
    bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes,
  });
  const base64 = (text: string): string => Buffer.from(text).toString('base64');
  // The host anchors the root's realpath; tmpdir() may not be one (macOS).
  beforeEach(() => {
    root = realpathSync(root);
  });

  it('captures a stable alias through its anchored realpath, keying evidence by the trusted root', async () => {
    const alias = join(dir, 'alias');
    symlinkSync(root, alias, 'dir');
    const { source, calls } = reader({ 'index.json': present('{}') });
    const evidence = jest.spyOn(log, 'captureEvidence');
    try {
      await expect(
        captureW5Files(log, alias, request, 'win32', source, root),
      ).resolves.toMatchObject({ files: [{ state: 'present' }] });
      expect(calls.map((call) => call.root)).toEqual([root]);
      expect(evidence).toHaveBeenCalledWith([
        { file: { kind: 'index' }, path: join(alias, 'index.json') },
      ]);
      // An unnormalized spelling of the anchored root is still that root.
      await expect(
        captureW5Files(log, `${root}/alpha/..`, request, 'win32', source, root),
      ).resolves.toMatchObject({ files: [{ state: 'present' }] });
      expect(calls.map((call) => call.root)).toEqual([root, root]);
    } finally {
      evidence.mockRestore();
    }
  });

  it.each([
    ['root-changed', 'a root that no longer resolves to its anchor'],
    ['root-unavailable', 'a root the host never anchored'],
  ] as const)(
    'refuses as %s %s before reading files or log evidence',
    async (...[refusal]) => {
      const elsewhere = join(dir, 'elsewhere');
      mkdirSync(elsewhere);
      const alias = join(dir, 'alias');
      // The alias anchored at host start, then retargeted (an ancestor swap).
      symlinkSync(elsewhere, alias, 'dir');
      const { source, calls } = reader({ 'index.json': present('{}') });
      const evidence = jest.spyOn(log, 'captureEvidence');
      try {
        await expect(
          captureW5Files(
            log,
            alias,
            request,
            'win32',
            source,
            refusal === 'root-changed' ? root : undefined,
          ),
        ).rejects.toMatchObject({
          reason: 'invalid-state',
          details: { capture: refusal },
        });
        expect(calls).toEqual([]);
        expect(evidence).not.toHaveBeenCalled();
      } finally {
        evidence.mockRestore();
      }
    },
  );

  it("anchors a root's realpath once, keeping an anchor it was given", async () => {
    const alias = join(dir, 'alias');
    symlinkSync(root, alias, 'dir');
    await expect(anchorW5CaptureRoot(alias, undefined)).resolves.toBe(root);
    // A later worker never resolves again, even once the alias is retargeted.
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(alias);
    symlinkSync(elsewhere, alias, 'dir');
    await expect(anchorW5CaptureRoot(alias, root)).resolves.toBe(root);
    await expect(
      anchorW5CaptureRoot(join(dir, 'missing'), undefined),
    ).resolves.toBeUndefined();
  });

  it('passes the anchored root through the request handler', async () => {
    const { source, calls } = reader({ 'index.json': present('{}') });
    const handler = (captureRoot?: string): W5CommitLogRequestHandler =>
      new W5CommitLogRequestHandler(
        log,
        { dbPath, root, ...(captureRoot !== undefined && { captureRoot }) },
        recovery,
        durability,
        'win32',
        source,
      );
    await expect(
      handler(root).run({ id: 1, method: 'capture', args: [request] }),
    ).resolves.toMatchObject({ files: [{ state: 'present' }] });
    for (const captureRoot of [undefined, join(dir, 'elsewhere')])
      await expect(
        handler(captureRoot)
          .run({ id: 1, method: 'capture', args: [request] })
          .catch(toW5CommitLogWorkerError),
      ).resolves.toMatchObject({
        kind: 'refused',
        details: {
          capture: captureRoot ? 'root-changed' : 'root-unavailable',
        },
      });
    expect(calls).toHaveLength(1);
  });

  it('reads every file only through the reader, under the resolved root, and discovers from its index', async () => {
    const indexText = '{"workspaces":[{"id":"alpha"},{"id":"beta"}]}';
    const { source, calls } = reader({
      'index.json': present(indexText),
      // A view into a larger buffer encodes only its own bytes.
      'alpha/workspace.json': present(Buffer.from('xxmanifest').subarray(2)),
      'alpha/worktrees.json': { state: 'unreadable', reason: 'unsafe-path' },
      'beta/workspace.json': { state: 'unreadable', reason: 'not-file' },
      'beta/worktrees.json': new Error('native failure'),
    });
    const opened = jest.spyOn(fs, 'open');
    const stat = jest.spyOn(fs, 'lstat');
    try {
      const result = await captureW5Files(
        log,
        root,
        request,
        'win32',
        source,
        root,
      );
      expect(result.discovery).toBe('complete');
      expect(result.files).toEqual([
        { kind: 'index', state: 'present', base64: base64(indexText) },
        {
          kind: 'manifest',
          workspaceId: 'alpha',
          state: 'present',
          base64: base64('manifest'),
        },
        {
          kind: 'worktrees',
          workspaceId: 'alpha',
          state: 'unreadable',
          reason: 'unsafe-path',
        },
        {
          kind: 'manifest',
          workspaceId: 'beta',
          state: 'unreadable',
          reason: 'not-file',
        },
        {
          kind: 'worktrees',
          workspaceId: 'beta',
          state: 'unreadable',
          reason: 'io',
        },
      ]);
      const resolvedRoot = realpathSync(root);
      const afterIndex = W5_CAPTURE_LIMITS.bytes - indexText.length;
      const afterManifest = afterIndex - 'manifest'.length;
      expect(calls).toEqual([
        {
          root: resolvedRoot,
          components: ['index.json'],
          maxBytes: W5_CAPTURE_LIMITS.bytes,
        },
        {
          root: resolvedRoot,
          components: ['alpha', 'workspace.json'],
          maxBytes: afterIndex,
        },
        {
          root: resolvedRoot,
          components: ['alpha', 'worktrees.json'],
          maxBytes: afterManifest,
        },
        {
          root: resolvedRoot,
          components: ['beta', 'workspace.json'],
          maxBytes: afterManifest,
        },
        {
          root: resolvedRoot,
          components: ['beta', 'worktrees.json'],
          maxBytes: afterManifest,
        },
      ]);
      expect(opened).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(isW5CaptureResult(result)).toBe(true);
      await expect(
        captureW5Files(
          log,
          root,
          { files: [{ kind: 'index-backup' }], discoverWorkspaces: false },
          'win32',
          source,
          root,
        ),
      ).resolves.toMatchObject({
        files: [{ kind: 'index-backup', state: 'absent' }],
        discovery: 'not-requested',
      });
    } finally {
      opened.mockRestore();
      stat.mockRestore();
    }
  });

  it.each([
    ['too-large', { state: 'too-large' }],
    [
      'more bytes than allowed',
      { state: 'present', bytes: Buffer.alloc(W5_CAPTURE_LIMITS.bytes + 1) },
    ],
  ] as const)(
    'refuses a reader result of %s as over the capture limit',
    async (_name, result) => {
      const { source } = reader({ 'index.json': result });
      await expect(
        captureW5Files(log, root, request, 'win32', source, root),
      ).rejects.toMatchObject({
        reason: 'invalid-state',
        details: { capture: 'limit-exceeded' },
      });
    },
  );

  it.each(['root-unavailable', 'root-changed'] as const)(
    'refuses the whole capture as %s when the reader finds the root moved after it was resolved, before reading log evidence',
    async (state) => {
      // The index read, then the root was swapped before the next file.
      const { source, calls } = reader({
        'index.json': present('{"workspaces":[{"id":"alpha"}]}'),
        'alpha/workspace.json': { state },
      });
      const evidence = jest.spyOn(log, 'captureEvidence');
      try {
        const refused = await captureW5Files(
          log,
          root,
          request,
          'win32',
          source,
          root,
        ).catch(toW5CommitLogWorkerError);
        expect(refused).toEqual({
          kind: 'refused',
          reason: 'invalid-state',
          message:
            state === 'root-changed'
              ? 'The W5 data root no longer resolves to its anchored path.'
              : 'The W5 data root could not be opened.',
          details: { capture: state },
        });
        // No later file is read, and no partial capture comes back.
        expect(calls.map((call) => call.components.join('/'))).toEqual([
          'index.json',
          'alpha/workspace.json',
        ]);
        expect(evidence).not.toHaveBeenCalled();
      } finally {
        evidence.mockRestore();
      }
    },
  );
});

it.each(['matching', 'outside', 'unavailable'])(
  'checks the Linux file descriptor before reading (%s)',
  async (location) => {
    index('inside');
    const target = join(realpathSync(root), 'index.json');
    const originalOpen = fs.open;
    let wasRead = (): boolean => false;
    let closeCount = (): number => 0;
    let descriptor: number | undefined;
    const opened = jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args) => {
        expect(args[1]).toBe(
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const handle = await originalOpen(...args);
        descriptor = handle.fd;
        const read = jest.spyOn(handle, 'read');
        const close = jest.spyOn(handle, 'close');
        wasRead = (): boolean => read.mock.calls.length > 0;
        closeCount = (): number => close.mock.calls.length;
        return handle;
      });
    const link = jest.spyOn(fs, 'readlink').mockImplementation((path) => {
      expect(path).toBe(`/proc/self/fd/${descriptor}`);
      if (location === 'unavailable')
        return Promise.reject(
          Object.assign(new Error('unavailable'), { code: 'ENOENT' }),
        );
      return Promise.resolve(
        location === 'matching' ? target : join(dir, 'outside', 'index.json'),
      );
    });
    try {
      const result = await captureW5Files(log, root, request, 'linux');
      expect(link).toHaveBeenCalledTimes(1);
      expect(closeCount()).toBe(1);
      if (location === 'matching') {
        expect(result.files[0]).toMatchObject({
          state: 'present',
          base64: Buffer.from('inside').toString('base64'),
        });
        expect(wasRead()).toBe(true);
      } else {
        expect(result.files[0]).toMatchObject({ state: 'unreadable' });
        expect(wasRead()).toBe(false);
      }
    } finally {
      opened.mockRestore();
      link.mockRestore();
    }
  },
);

it('rejects a workspace directory switched outside during open and restored before reading', async () => {
  const workspace = join(realpathSync(root), 'alpha');
  const parked = join(realpathSync(root), 'parked');
  const outside = join(dir, 'outside');
  const target = join(workspace, 'workspace.json');
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(target, 'inside');
  writeFileSync(join(outside, 'workspace.json'), 'outside secret');
  const originalLstat = fs.lstat;
  const originalOpen = fs.open;
  let switched = false;
  const stat = jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === target && !switched) {
      switched = true;
      await fs.rename(workspace, parked);
      await fs.symlink(outside, workspace, 'junction');
    }
    return originalLstat(...args);
  });
  const opened = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    try {
      if (args[0] === target) {
        await fs.unlink(workspace);
        await fs.rename(parked, workspace);
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  });
  try {
    const result = await capture({
      files: [{ kind: 'manifest', workspaceId: 'alpha' }],
      discoverWorkspaces: false,
    });
    expect(switched).toBe(true);
    expect(result.files).toEqual([
      {
        kind: 'manifest',
        workspaceId: 'alpha',
        state: 'unreadable',
        reason: 'unsafe-path',
      },
    ]);
  } finally {
    stat.mockRestore();
    opened.mockRestore();
  }
});

it('rejects an ancestor restored only at realpath revalidation', async () => {
  const workspace = join(realpathSync(root), 'alpha');
  const parked = join(realpathSync(root), 'parked');
  const outside = join(dir, 'outside');
  const target = join(workspace, 'workspace.json');
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(target, 'inside');
  writeFileSync(join(outside, 'workspace.json'), 'outside secret');
  const originalLstat = fs.lstat;
  const originalRealpath = fs.realpath;
  const originalOpen = fs.open;
  const descriptorLink = jest.spyOn(fs, 'readlink');
  let switched = false;
  let restored = false;
  let refusedAtOpen = false;
  const opened = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    try {
      return await originalOpen(...args);
    } catch (error) {
      if (args[0] === target) {
        expect(args[1]).toBe(
          constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000,
        );
        expect(error).toMatchObject({ code: 'ELOOP' });
        refusedAtOpen = true;
      }
      throw error;
    }
  });
  const stat = jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === target && !switched) {
      switched = true;
      await fs.rename(workspace, parked);
      await fs.symlink(outside, workspace, 'junction');
    }
    return originalLstat(...args);
  });
  const resolved = jest
    .spyOn(fs, 'realpath')
    .mockImplementation(async (...args) => {
      if (args[0] === target && switched && !restored) {
        restored = true;
        await fs.unlink(workspace);
        await fs.rename(parked, workspace);
      }
      return originalRealpath(...args);
    });
  try {
    const result = await capture({
      files: [{ kind: 'manifest', workspaceId: 'alpha' }],
      discoverWorkspaces: false,
    });
    expect(switched).toBe(true);
    // Atomic Darwin open can refuse before pathname revalidation is reached.
    // Linux must reject the outside descriptor even if revalidation restores it.
    if (process.platform === 'darwin') expect(refusedAtOpen).toBe(true);
    else expect(descriptorLink).toHaveBeenCalledTimes(1);
    expect(result.files).toEqual([
      {
        kind: 'manifest',
        workspaceId: 'alpha',
        state: 'unreadable',
        reason: 'unsafe-path',
      },
    ]);
    expect(isW5CaptureResult(result)).toBe(true);
  } finally {
    stat.mockRestore();
    resolved.mockRestore();
    opened.mockRestore();
    descriptorLink.mockRestore();
  }
});

it('bounds applied file evidence independently of append-only history', async () => {
  index('{"workspaces":[]}');
  let latest = 0;
  for (let i = 0; i <= W5_CAPTURE_LIMITS.evidenceRows; i++) {
    const saved = log.commit({
      operation: 'test',
      files: [
        {
          path: join(root, 'index.json'),
          previousFingerprint: fingerprintW5File('{}'),
          contents: '{}',
        },
      ],
      advance: [{ kind: 'workspaces' }],
      outcome: null,
    });
    log.markApplied(saved.commitId);
    latest = saved.commitId;
  }
  const before = disk();
  const result = await capture();
  expect(result.discovery).toBe('complete');
  expect(disk()).toEqual(before);
  expect(result.log.files).toEqual([
    {
      file: { kind: 'index' },
      commitId: latest,
      state: 'applied',
      previousFingerprint: fingerprintW5File('{}'),
      newFingerprint: fingerprintW5File('{}'),
    },
  ]);
  expect(result.log.revisions).toEqual({
    workspaces: W5_CAPTURE_LIMITS.evidenceRows + 1,
  });
  expect(result.log.resourceRevisionEligibility).toBe('unproven');
  expect(isW5CaptureResult(result)).toBe(true);
}, 30000);

it('excludes unrelated revision history while retaining captured workspace scopes exactly', async () => {
  index('{"workspaces":[{"id":"a_b"}]}');
  log.commit({
    operation: 'test',
    files: [],
    outcome: null,
    advance: [
      ...Array.from({ length: W5_CAPTURE_LIMITS.evidenceRows + 1 }, (_, i) => ({
        kind: 'workspace' as const,
        workspaceId: `old-${i}`,
      })),
      { kind: 'workspaces' },
      { kind: 'workspace', workspaceId: 'a_b' },
      { kind: 'worktrees', workspaceId: 'a_b' },
      { kind: 'worktree', workspaceId: 'a_b', worktreeId: 'one' },
      { kind: 'worktree', workspaceId: 'a_b', worktreeId: 'deleted' },
      { kind: 'worktree', workspaceId: 'axb', worktreeId: 'one' },
      { kind: 'worktree', workspaceId: 'a_b_extra', worktreeId: 'one' },
    ],
  });
  const result = await capture();
  expect(result.log.revisions).toEqual({
    workspaces: 1,
    'workspace:a_b': 1,
    'worktrees:a_b': 1,
    'worktree:a_b/one': 1,
    'worktree:a_b/deleted': 1,
  });
  expect(
    (await capture({ files: [], discoverWorkspaces: false })).log.revisions,
  ).toEqual({});
  expect(
    (
      await capture({
        files: [{ kind: 'manifest', workspaceId: 'a_b' }],
        discoverWorkspaces: false,
      })
    ).log.revisions,
  ).toEqual({ 'workspace:a_b': 1 });
  expect(
    (
      await capture({
        files: [{ kind: 'index-backup' }],
        discoverWorkspaces: false,
      })
    ).log.revisions,
  ).toEqual({ workspaces: 1 });
});

it('retains unresolved decisions on either side of the latest applied decision per file', async () => {
  const save = (kind: 'index' | 'index-backup', contents: string): number =>
    log.commit({
      operation: 'test',
      files: [
        {
          path: join(root, kind === 'index' ? 'index.json' : 'index.json.bak'),
          previousFingerprint: null,
          contents,
        },
      ],
      advance: [{ kind: 'workspaces' }],
      outcome: null,
    }).commitId;
  const old = save('index', 'old');
  log.markApplied(old);
  const conflict = save('index', 'conflict');
  log.markApplied(conflict);
  const pendingBefore = save('index', 'pending-before');
  log.markApplied(pendingBefore);
  const applied = save('index', 'latest');
  log.markApplied(applied);
  const pendingAfter = save('index', 'pending-after');
  log.markApplied(pendingAfter);
  const backup = save('index-backup', 'backup');
  log.markApplied(backup);
  // Admission prevents overlapping pending writes; seed retained anomalous rows
  // to prove capture does not silently discard unresolved evidence.
  log.close();
  const raw = new DatabaseSync(dbPath);
  try {
    const state = raw.prepare(
      'UPDATE w5_commits SET state = ?, completed_at = NULL WHERE commit_id = ?',
    );
    const contents = raw.prepare(
      'UPDATE w5_commit_files SET contents = ? WHERE commit_id = ?',
    );
    state.run('recovery-required', conflict);
    contents.run('conflict', conflict);
    state.run('committed', pendingBefore);
    contents.run('pending-before', pendingBefore);
    state.run('committed', pendingAfter);
    contents.run('pending-after', pendingAfter);
  } finally {
    raw.close();
    log = W5CommitLog.open(dbPath);
  }
  const before = disk();
  const result = await capture({
    files: [{ kind: 'index' }, { kind: 'index-backup' }],
    discoverWorkspaces: false,
  });
  expect(
    result.log.files.map(({ file, commitId, state, newFingerprint }) => ({
      file,
      commitId,
      state,
      newFingerprint,
    })),
  ).toEqual([
    {
      file: { kind: 'index' },
      commitId: conflict,
      state: 'recovery-required',
      newFingerprint: fingerprintW5File('conflict'),
    },
    {
      file: { kind: 'index' },
      commitId: pendingBefore,
      state: 'committed',
      newFingerprint: fingerprintW5File('pending-before'),
    },
    {
      file: { kind: 'index' },
      commitId: applied,
      state: 'applied',
      newFingerprint: fingerprintW5File('latest'),
    },
    {
      file: { kind: 'index' },
      commitId: pendingAfter,
      state: 'committed',
      newFingerprint: fingerprintW5File('pending-after'),
    },
    {
      file: { kind: 'index-backup' },
      commitId: backup,
      state: 'applied',
      newFingerprint: fingerprintW5File('backup'),
    },
  ]);
  expect(result.log.resourceRevisionEligibility).toBe('unproven');
  expect(isW5CaptureResult(result)).toBe(true);
  expect(disk()).toEqual(before);
});

it('counts relevant unresolved decisions and revisions together at the evidence boundary', async () => {
  log.commit({
    operation: 'test',
    files: [
      {
        path: join(root, 'alpha', 'worktrees.json'),
        previousFingerprint: null,
        contents: '{}',
      },
    ],
    advance: Array.from(
      { length: W5_CAPTURE_LIMITS.evidenceRows - 1 },
      (_, i) => ({
        kind: 'worktree',
        workspaceId: 'alpha',
        worktreeId: `w${i}`,
      }),
    ),
    outcome: null,
  });
  const input: W5CaptureRequest = {
    files: [{ kind: 'worktrees', workspaceId: 'alpha' }],
    discoverWorkspaces: false,
  };
  const result = await capture(input);
  expect(Object.keys(result.log.revisions)).toHaveLength(
    W5_CAPTURE_LIMITS.evidenceRows - 1,
  );
  expect(result.log.files).toHaveLength(1);
  expect(result.log.files[0]?.state).toBe('committed');
  expect(isW5CaptureResult(result)).toBe(true);
  log.commit({
    operation: 'test',
    files: [],
    advance: [{ kind: 'worktrees', workspaceId: 'alpha' }],
    outcome: null,
  });
  await expect(capture(input)).rejects.toMatchObject({
    details: { capture: 'limit-exceeded' },
  });
});

it('bounds relevant revision key length without rejecting unrelated oversized keys', async () => {
  log.commit({
    operation: 'test',
    files: [],
    outcome: null,
    advance: [
      { kind: 'worktree', workspaceId: 'alpha', worktreeId: 'x'.repeat(513) },
    ],
  });
  expect((await capture()).log.revisions).toEqual({});
  await expect(
    capture({
      files: [{ kind: 'worktrees', workspaceId: 'alpha' }],
      discoverWorkspaces: false,
    }),
  ).rejects.toMatchObject({ details: { capture: 'limit-exceeded' } });
});

it('bounds discovery, total captured bytes and evidence instead of returning a truncated success', async () => {
  index(
    JSON.stringify({
      workspaces: Array.from({ length: 128 }, (_, i) => ({
        id: `workspace-${i}`,
      })),
    }),
  );
  await expect(capture()).rejects.toMatchObject({
    reason: 'invalid-state',
    details: { capture: 'limit-exceeded' },
  });
  index(Buffer.alloc(W5_CAPTURE_LIMITS.bytes));
  expect(
    (await capture({ ...request, discoverWorkspaces: false })).files[0],
  ).toMatchObject({ state: 'present' });
  writeFileSync(join(root, 'index.json.bak'), 'x');
  await expect(
    capture({
      files: [{ kind: 'index' }, { kind: 'index-backup' }],
      discoverWorkspaces: false,
    }),
  ).rejects.toMatchObject({ details: { capture: 'limit-exceeded' } });
  index(Buffer.alloc(W5_CAPTURE_LIMITS.bytes + 1));
  await expect(capture()).rejects.toMatchObject({
    details: { capture: 'limit-exceeded' },
  });
  index('{}');
  log.commit({
    operation: 'test',
    files: [],
    advance: Array.from(
      { length: W5_CAPTURE_LIMITS.evidenceRows + 1 },
      (_, i) => ({
        kind: 'worktree',
        workspaceId: 'alpha',
        worktreeId: `w${i}`,
      }),
    ),
    outcome: null,
  });
  await expect(
    capture({
      files: [{ kind: 'worktrees', workspaceId: 'alpha' }],
      discoverWorkspaces: false,
    }),
  ).rejects.toMatchObject({
    details: { capture: 'limit-exceeded' },
  });
});

it('preserves pending/conflicted evidence and never recovers, reserves, compacts or advances anything', async () => {
  index('{"workspaces":[]}');
  const pending = log.commit({
    operation: 'test',
    files: [
      {
        path: join(root, 'index.json'),
        previousFingerprint: fingerprintW5File('{"workspaces":[]}'),
        contents: 'pending',
      },
    ],
    advance: [{ kind: 'workspaces' }],
    outcome: null,
  });
  log.reserve({ reservationId: 'live', operation: 'test', diagnostics: null });
  const before = disk();
  const handler = new W5CommitLogRequestHandler(
    log,
    { root, dbPath },
    recovery,
    durability,
    process.platform,
  );
  const result = await handler.run({
    id: 1,
    method: 'capture',
    args: [request],
  });
  expect(result).toMatchObject({
    log: {
      commitId: pending.commitId,
      revisions: { workspaces: 1 },
      resourceRevisionEligibility: 'unproven',
      files: [
        {
          state: 'committed',
          previousFingerprint: fingerprintW5File('{"workspaces":[]}'),
          newFingerprint: fingerprintW5File('pending'),
        },
      ],
    },
  });
  expect(disk()).toEqual(before);
  expect(log.listPendingCommits()).toHaveLength(1);
  expect(log.listReservations()[0]?.state).toBe('reserved');
  expect(durability.writeFileDurably).not.toHaveBeenCalled();
  expect(durability.syncDirectory).not.toHaveBeenCalled();
  expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(
    '{"workspaces":[]}',
  );
  log.markCommitRecoveryRequired(pending.commitId, { conflict: true });
  const conflictBefore = disk();
  expect((await capture()).log.files[0]?.state).toBe('recovery-required');
  expect(disk()).toEqual(conflictBefore);
  expect(() => log.snapshot()).toThrow('recovery');
});

it('retains applied fingerprints after compaction, without assigning eligibility even to identical images', async () => {
  index('{}');
  const saved = log.commit({
    operation: 'test',
    files: [
      {
        path: join(root, 'index.json'),
        previousFingerprint: null,
        contents: '{}',
      },
    ],
    advance: [{ kind: 'workspaces' }],
    outcome: null,
  });
  log.markApplied(saved.commitId);
  log.compact();
  const result = await capture();
  expect(result.log.files[0]).toMatchObject({
    state: 'applied',
    newFingerprint: fingerprintW5File('{}'),
  });
  expect(result.log.resourceRevisionEligibility).toBe('unproven');
  expect(
    isW5CaptureResult({
      ...result,
      files: [{ kind: 'index', state: 'present', base64: '!!' }],
    }),
  ).toBe(false);
  expect(
    isW5CaptureResult({
      ...result,
      extra: 'x'.repeat(W5_CAPTURE_LIMITS.responseBytes),
    }),
  ).toBe(false);
});

it('bounds serialized evidence plus image bytes, including JSON escaping expansion', async () => {
  index(Buffer.alloc(W5_CAPTURE_LIMITS.bytes));
  log.commit({
    operation: 'test',
    files: [],
    outcome: null,
    advance: Array.from({ length: 2100 }, (_, i) => ({
      kind: 'worktree',
      workspaceId: 'alpha',
      worktreeId: `${'\u0001'.repeat(480)}${i}`,
    })),
  });
  await expect(
    capture({
      files: [{ kind: 'index' }, { kind: 'worktrees', workspaceId: 'alpha' }],
      discoverWorkspaces: false,
    }),
  ).rejects.toMatchObject({ details: { capture: 'limit-exceeded' } });
});

it('retains the allocation high-water mark and revision after abandonment without inventing file provenance', async () => {
  index('{}');
  const saved = log.commit({
    operation: 'test',
    files: [
      {
        path: join(root, 'index.json'),
        previousFingerprint: null,
        contents: '{}',
      },
    ],
    advance: [
      { kind: 'workspaces' },
      { kind: 'worktree', workspaceId: 'alpha', worktreeId: 'embedded\0nul' },
    ],
    outcome: null,
  });
  log.markCommitRecoveryRequired(saved.commitId, null);
  log.abandonRecoveryRequiredCommit(saved.commitId);
  const result = await capture({
    files: [{ kind: 'index' }, { kind: 'worktrees', workspaceId: 'alpha' }],
    discoverWorkspaces: false,
  });
  expect(result.log).toMatchObject({
    commitId: saved.commitId,
    revisions: { workspaces: 1, 'worktree:alpha/embedded\0nul': 1 },
    files: [],
    resourceRevisionEligibility: 'unproven',
  });
  expect(log.snapshot().commitId).toBe(0);
});

it('accepts the file-count boundary and rejects sparse selectors', async () => {
  const files: W5CaptureRequest['files'] = Array.from(
    { length: 256 },
    (_, i) => ({ kind: 'manifest', workspaceId: `workspace-${i}` }),
  );
  expect(
    (await capture({ files, discoverWorkspaces: false })).files,
  ).toHaveLength(256);
  expect(
    isW5CaptureRequest({ files: new Array(1), discoverWorkspaces: false }),
  ).toBe(false);
});
