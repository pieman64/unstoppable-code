import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpConfigRepository } from '../mcp/config-repository';
import { McpConfigStateError } from '../mcp/config-repository-format';
import type {
  McpServerData,
  McpServerIndexEntry,
} from '@canopy/desktop-shared/types/mcp-servers';

jest.mock('node:fs/promises');
const filePath = (path: Parameters<typeof readFile>[0]): string => {
  if (typeof path === 'string') return path;
  if (Buffer.isBuffer(path)) return path.toString('utf8');
  if (path instanceof URL) return fileURLToPath(path);
  throw new Error('Expected a file path');
};
const paths = {
  index: (): string => '/mock/index.json',
  server: (id: string): string => `/mock/server-${id}.json`,
};
const server: McpServerData = {
  definition: {
    id: 'aaa',
    name: 'A',
    description: '',
    type: 'http',
    url: 'https://new.test',
    createdAt: '',
    updatedAt: '',
  },
  configs: [],
};
const entry: McpServerIndexEntry = {
  id: 'aaa',
  name: 'A',
  description: '',
  type: 'http',
  configs: [],
  updatedAt: '',
};
const config = {
  id: 'cfg',
  name: 'Default',
  description: '',
  enabled: true,
  envVars: {},
  extraArgs: [],
  extraHeaders: {},
  createdAt: '',
  updatedAt: '',
};
const missing = (): Error =>
  Object.assign(new Error('missing'), { code: 'ENOENT' });
// `readdir` is overloaded; the repository uses the file-name form.
const mockedReaddir = jest.mocked(readdir) as unknown as jest.MockedFunction<
  (path: string) => Promise<string[]>
>;
let repository: McpConfigRepository;
let files: Map<string, string>;
let directory: string[] | Error;
beforeEach(() => {
  jest.resetAllMocks();
  repository = new McpConfigRepository(paths, {
    mkdir,
    readFile,
    readdir,
    unlink,
    writeFile,
  });
  files = new Map([
    [paths.index(), JSON.stringify({ version: 1, servers: [entry] })],
  ]);
  directory = [];
  jest.mocked(readFile).mockImplementation((path) => {
    const value = files.get(filePath(path));
    if (value === undefined) return Promise.reject(missing());
    return Promise.resolve(value);
  });
  mockedReaddir.mockImplementation(() =>
    directory instanceof Error
      ? Promise.reject(directory)
      : Promise.resolve(directory),
  );
  jest.mocked(writeFile).mockImplementation((path, data) => {
    if (typeof data !== 'string') throw new Error('Expected JSON text');
    files.set(filePath(path), data);
    return Promise.resolve();
  });
  jest.mocked(unlink).mockImplementation((path) => {
    files.delete(filePath(path));
    return Promise.resolve();
  });
});

const stored = (path: string): unknown => JSON.parse(files.get(path) ?? '');

it.each(['server', 'index'] as const)(
  'continues after a failed %s write without claiming atomic publication',
  async (failure) => {
    const failedPath =
      failure === 'server' ? paths.server('aaa') : paths.index();
    jest.mocked(writeFile).mockImplementationOnce((path, data) => {
      if (filePath(path) === failedPath)
        return Promise.reject(new Error('write failed'));
      if (typeof data !== 'string') throw new Error('Expected JSON text');
      files.set(filePath(path), data);
      return Promise.resolve();
    });
    if (failure === 'index')
      jest.mocked(writeFile).mockRejectedValueOnce(new Error('write failed'));
    const failed = repository.save('aaa', () => ({ server, entry }));
    const recovered = repository.save('aaa', () => ({
      server,
      entry: { ...entry, name: 'Recovered' },
    }));
    await expect(failed).rejects.toThrow('write failed');
    await recovered;
    expect((await repository.readIndex()).servers[0].name).toBe('Recovered');
  },
);

it('keeps legacy unlink-success/index-failure retry behavior', async () => {
  files.set(paths.server('aaa'), JSON.stringify({ version: 1, server }));
  jest.mocked(writeFile).mockRejectedValueOnce(new Error('index failed'));
  await expect(repository.remove('aaa')).rejects.toThrow('index failed');
  expect(files.has(paths.server('aaa'))).toBe(false);
  expect((await repository.readIndex()).servers).toHaveLength(1);
  jest.mocked(unlink).mockRejectedValueOnce(missing());
  await repository.remove('aaa');
  expect((await repository.readIndex()).servers).toEqual([]);
});

it.each(['{bad', '{"version":2,"servers":[]}', undefined])(
  'preserves forgiving deletion for damaged index %s',
  async (contents) => {
    if (contents === undefined) files.delete(paths.index());
    else files.set(paths.index(), contents);
    await repository.remove('aaa');
    expect(unlink).toHaveBeenCalledWith(paths.server('aaa'));
    expect((await repository.readIndex()).servers).toEqual([]);
  },
);

const duplicateIndex = JSON.stringify({ version: 1, servers: [entry, entry] });
const badRouting = JSON.stringify({
  version: 1,
  servers: [{ ...entry, scope: 'team' }],
});
const otherServer = JSON.stringify({
  version: 1,
  server: { ...server, definition: { ...server.definition, id: 'bbb' } },
});
describe.each([
  ['index', 'invalid JSON', '{bad', 'malformed'],
  ['index', 'unsupported version', '{"version":2,"servers":[]}', 'unsupported'],
  ['index', 'duplicate ids', duplicateIndex, 'malformed'],
  ['index', 'invalid routing', badRouting, 'malformed'],
  ['index', 'I/O failure', new Error('EIO'), 'unreadable'],
  ['index', 'ENOENT only in its message', new Error('ENOENT'), 'unreadable'],
  ['server', 'invalid JSON', '{bad', 'malformed'],
  ['server', 'unsupported version', '{"version":2}', 'unsupported'],
  ['server', 'another identity', otherServer, 'malformed'],
  ['server', 'I/O failure', new Error('EIO'), 'unreadable'],
] as const)('a %s with %s', (document, _case, contents, state) => {
  beforeEach(() => {
    const path = document === 'index' ? paths.index() : paths.server('aaa');
    const prior = jest.mocked(readFile).getMockImplementation();
    jest.mocked(readFile).mockImplementation((requested, options) => {
      if (filePath(requested) === path)
        return contents instanceof Error
          ? Promise.reject(contents)
          : Promise.resolve(contents);
      if (!prior) throw new Error('Missing read mock');
      return prior(requested, options);
    });
  });

  it('refuses save before any write, then lets the queue continue', async () => {
    const prepare = jest.fn(() => ({ server, entry }));
    const refused = repository.save('aaa', prepare);
    const next = repository.save('bbb', () => ({
      server: { ...server, definition: { ...server.definition, id: 'bbb' } },
      entry: { ...entry, id: 'bbb' },
    }));
    await expect(refused).rejects.toBeInstanceOf(McpConfigStateError);
    await expect(refused).rejects.toMatchObject({ document, state });
    expect(prepare).not.toHaveBeenCalled();
    if (document === 'index') {
      await expect(next).rejects.toMatchObject({ document, state });
      expect(writeFile).not.toHaveBeenCalled();
    } else {
      await expect(next).resolves.toMatchObject({ version: 1 });
      expect(
        jest
          .mocked(writeFile)
          .mock.calls.map(([path]) => filePath(path))
          .sort(),
      ).toEqual([paths.index(), paths.server('bbb')]);
    }
  });

  if (document === 'index')
    it('refuses backfill without writing', async () => {
      await expect(
        repository.backfill(
          () => true,
          () => ({ urlHost: 'new.test', urlScheme: 'https' }),
        ),
      ).rejects.toMatchObject({ document, state });
      expect(writeFile).not.toHaveBeenCalled();
    });
  else
    it('is refused by the strict mutation read', async () => {
      await expect(
        repository.readServerForMutation('aaa'),
      ).rejects.toMatchObject({ document, state });
    });
});

describe('missing index initialization', () => {
  beforeEach(() => files.delete(paths.index()));

  it.each([
    ['an absent directory', missing()],
    ['an empty directory', []],
    [
      'only the catalog and tools cache',
      ['curated-catalog.json', 'tools-cache.json'],
    ],
  ])('creates the index with %s', async (_case, listing) => {
    directory = listing;
    await repository.save('aaa', () => ({ server, entry }));
    expect(stored(paths.index())).toEqual({ version: 1, servers: [entry] });
  });

  it('retries a first save whose index write failed', async () => {
    jest.mocked(writeFile).mockImplementationOnce((path, data) => {
      if (typeof data !== 'string') throw new Error('Expected JSON text');
      files.set(filePath(path), data);
      directory = ['server-aaa.json'];
      return Promise.resolve();
    });
    jest.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));
    await expect(
      repository.save('aaa', () => ({ server, entry })),
    ).rejects.toThrow('disk full');
    await repository.save('aaa', () => ({ server, entry }));
    expect(stored(paths.index())).toEqual({ version: 1, servers: [entry] });
  });

  it.each<[string, string[] | Error, string]>([
    [
      'another orphaned server file',
      ['server-aaa.json', 'server-bbb.json'],
      'orphaned',
    ],
    ['an unreadable directory', new Error('EACCES'), 'unreadable'],
  ])('refuses with %s', async (_case, listing, state) => {
    directory = listing;
    await expect(
      repository.save('aaa', () => ({ server, entry })),
    ).rejects.toMatchObject({ document: 'index', state });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('reads an absent server as undefined and backfills nothing', async () => {
    await expect(
      repository.readServerForMutation('aaa'),
    ).resolves.toBeUndefined();
    await expect(
      repository.backfill(
        () => true,
        () => ({ urlHost: 'x' }),
      ),
    ).resolves.toEqual({ index: { version: 1, servers: [] }, changed: false });
    expect(writeFile).not.toHaveBeenCalled();
  });
});

it('preserves unknown fields while replacing known ones', async () => {
  const other = { ...entry, id: 'bbb', future: { nested: [1] } };
  files.set(
    paths.index(),
    JSON.stringify({
      version: 1,
      indexNote: 'keep',
      accountConnectionsAvailable: false,
      servers: [
        {
          ...entry,
          entryNote: 'keep',
          accountConnectionId: 'a1111111-1111-4111-8111-111111111111',
          scope: 'account',
          configs: [{ id: 'cfg', name: 'Default', enabled: true, row: 'keep' }],
        },
        other,
      ],
    }),
  );
  files.set(
    paths.server('aaa'),
    JSON.stringify({
      version: 1,
      envelopeNote: 'keep',
      server: {
        serverNote: { nested: 'keep' },
        definition: {
          ...server.definition,
          definitionNote: 'keep',
          headers: { 'X-Old': 'drop' },
          oauth: { clientId: 'old', oauthNote: 'keep' },
          curated: { key: 'cat', curatedNote: 'keep', docsUrl: 'drop' },
        },
        configs: [
          { ...config, authToken: 'secret', configNote: 'keep' },
          { ...config, id: 'removed', configNote: 'drop' },
        ],
      },
    }),
  );
  const saved = await repository.save('aaa', () => ({
    server: {
      definition: {
        ...server.definition,
        oauth: { clientId: 'new' },
        curated: { key: 'cat' },
      },
      configs: [{ ...config, enabled: false }],
    },
    entry: {
      ...entry,
      configs: [{ id: 'cfg', name: 'Default', enabled: false }],
    },
  }));
  expect(stored(paths.server('aaa'))).toEqual({
    version: 1,
    envelopeNote: 'keep',
    server: {
      serverNote: { nested: 'keep' },
      definition: {
        ...server.definition,
        definitionNote: 'keep',
        oauth: { clientId: 'new', oauthNote: 'keep' },
        curated: { key: 'cat', curatedNote: 'keep' },
      },
      configs: [{ ...config, enabled: false, configNote: 'keep' }],
    },
  });
  expect(saved.server.configs[0]).not.toHaveProperty('authToken');
  expect(stored(paths.index())).toEqual({
    version: 1,
    indexNote: 'keep',
    servers: [
      {
        ...entry,
        entryNote: 'keep',
        configs: [{ id: 'cfg', name: 'Default', enabled: false, row: 'keep' }],
      },
      other,
    ],
  });
});

it('drops curated extensions when the curated key changes', async () => {
  files.set(
    paths.server('aaa'),
    JSON.stringify({
      version: 1,
      server: {
        ...server,
        definition: {
          ...server.definition,
          curated: { key: 'old', curatedNote: 'old entry' },
        },
      },
    }),
  );
  await repository.save('aaa', () => ({
    server: {
      ...server,
      definition: { ...server.definition, curated: { key: 'new' } },
    },
    entry,
  }));
  expect(stored(paths.server('aaa'))).toMatchObject({
    server: { definition: { curated: { key: 'new' } } },
  });
  expect(files.get(paths.server('aaa'))).not.toContain('curatedNote');
});

it.each<[string, McpServerData, string]>([
  [
    'a non-integer OAuth port',
    {
      ...server,
      definition: { ...server.definition, oauth: { callbackPort: 1.5 } },
    },
    'Invalid MCP server',
  ],
  [
    'a blank curated key',
    { ...server, definition: { ...server.definition, curated: { key: ' ' } } },
    'Curated MCP server key is required.',
  ],
  [
    'duplicate configs',
    { ...server, configs: [config, config] },
    'duplicate config ids',
  ],
  [
    'another identity',
    { ...server, definition: { ...server.definition, id: 'bbb' } },
    'MCP server id changed during save.',
  ],
])(
  'refuses to write %s the strict reader would reject',
  async (_case, proposed, message) => {
    await expect(
      repository.save('aaa', () => ({ server: proposed, entry })),
    ).rejects.toThrow(message);
    expect(writeFile).not.toHaveBeenCalled();
  },
);

it('backfills from raw entries, preserving unknown fields and skipping other identities', async () => {
  files.set(
    paths.index(),
    JSON.stringify({
      version: 1,
      indexNote: 'keep',
      servers: [
        { ...entry, entryNote: 'keep' },
        { ...entry, id: 'bbb' },
      ],
    }),
  );
  files.set(paths.server('aaa'), JSON.stringify({ version: 1, server }));
  // bbb's file names another server; its URL must not be borrowed.
  files.set(paths.server('bbb'), JSON.stringify({ version: 1, server }));
  const result = await repository.backfill(
    () => true,
    (value) => ({ urlHost: new URL(value.definition.url ?? '').host }),
  );
  expect(result.changed).toBe(true);
  expect(stored(paths.index())).toEqual({
    version: 1,
    indexNote: 'keep',
    servers: [
      { ...entry, entryNote: 'keep', urlHost: 'new.test' },
      { ...entry, id: 'bbb' },
    ],
  });
});

it('does not publish stale backfill fields after a queued replacement', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  jest
    .mocked(readFile)
    .mockImplementationOnce(() =>
      Promise.resolve(JSON.stringify({ version: 1, servers: [entry] })),
    )
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return JSON.stringify({
        version: 1,
        server: {
          ...server,
          definition: { ...server.definition, url: 'https://old.test' },
        },
      });
    });
  const backfill = repository.backfill(
    () => true,
    (value) => ({ urlHost: new URL(value.definition.url ?? '').host }),
  );
  await entered.promise;
  const save = repository.save('aaa', () => ({
    server,
    entry: { ...entry, urlHost: 'new.test' },
  }));
  try {
    expect(writeFile).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  await Promise.all([backfill, save]);
  expect((await repository.readIndex()).servers[0].urlHost).toBe('new.test');
});

it('releases a rejected server lease while excluding same-server mutations only', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = repository.withServerMutation('aaa', async () => {
    entered.resolve();
    await release.promise;
    throw new Error('failed');
  });
  const failure = expect(first).rejects.toThrow('failed');
  await entered.promise;
  const next = jest.fn(() => Promise.resolve());
  const second = repository.withServerMutation('aaa', next);
  await repository.withServerMutation('bbb', () => Promise.resolve());
  try {
    expect(next).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  await Promise.all([failure, second]);
  expect(next).toHaveBeenCalledTimes(1);
});
