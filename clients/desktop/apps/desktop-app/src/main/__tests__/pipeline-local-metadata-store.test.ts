import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('node:fs', () => {
  const actual: typeof fs = jest.requireActual('node:fs');
  return { ...actual, readFileSync: jest.fn(actual.readFileSync) };
});

let mockMetadataPath = '';
jest.mock('../lib/paths', () => ({
  getPipelineLocalMetadataFilePath: (): string => mockMetadataPath,
}));

import {
  deleteUserPipelineLocalMetadata,
  isPipelineLocalMetadataReadable,
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
  setUserPipelineAgentAuthor,
} from '../pipelines/pipeline-local-metadata-store';

const USER_LOCATOR = {
  type: 'stored' as const,
  source: 'user' as const,
  value: 'pipeline-1',
};
const AUTHOR = {
  chat: { projectId: 'project-1', worktreeId: 'task-1', chatId: 'chat-1' },
  recordedAt: '2026-10-19T00:00:00.000Z',
};

function readFile(): unknown {
  return JSON.parse(fs.readFileSync(mockMetadataPath, 'utf8'));
}

describe('pipeline local metadata store', () => {
  let tempDir: string;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-metadata-'));
    mockMetadataPath = path.join(
      tempDir,
      'data',
      'pipeline-local-metadata.json',
    );
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads nothing from a missing file without warning', () => {
    expect(readPipelineLocalMetadata(USER_LOCATOR)).toEqual({});
    expect(stderr).not.toHaveBeenCalled();
  });

  it('records the owner and agent author under the stored user locator', () => {
    recordUserPipelineOwner('pipeline-1', 'personal');
    setUserPipelineAgentAuthor('pipeline-1', AUTHOR);

    expect(readPipelineLocalMetadata(USER_LOCATOR)).toEqual({
      owner: 'personal',
      agentAuthor: AUTHOR,
    });
    expect(readFile()).toEqual({
      version: 1,
      entries: {
        'stored:user:pipeline-1': { owner: 'personal', agentAuthor: AUTHOR },
      },
    });
    expect(
      readPipelineLocalMetadata({ ...USER_LOCATOR, source: 'bundled' }),
    ).toEqual({});
  });

  it('clears the marker and keeps the owner', () => {
    recordUserPipelineOwner('pipeline-1', 'personal');
    setUserPipelineAgentAuthor('pipeline-1', AUTHOR);
    setUserPipelineAgentAuthor('pipeline-1', null);

    expect(readPipelineLocalMetadata(USER_LOCATOR)).toEqual({
      owner: 'personal',
    });
  });

  it('does not create a file to clear a marker that was never set', () => {
    setUserPipelineAgentAuthor('pipeline-1', null);
    expect(fs.existsSync(mockMetadataPath)).toBe(false);
  });

  it('deletes an entry and ignores a missing one', () => {
    recordUserPipelineOwner('pipeline-1', 'personal');
    recordUserPipelineOwner('pipeline-2', 'personal');
    deleteUserPipelineLocalMetadata('pipeline-1');
    deleteUserPipelineLocalMetadata('missing');

    expect(readPipelineLocalMetadata(USER_LOCATOR)).toEqual({});
    expect(
      readPipelineLocalMetadata({ ...USER_LOCATOR, value: 'pipeline-2' }),
    ).toEqual({ owner: 'personal' });
  });

  it('writes the file readable only by the user', () => {
    recordUserPipelineOwner('pipeline-1', 'personal');
    expect(fs.statSync(mockMetadataPath).mode & 0o777).toBe(0o600);
  });

  it('warns and uses empty defaults for a malformed file', () => {
    fs.mkdirSync(path.dirname(mockMetadataPath), { recursive: true });
    fs.writeFileSync(mockMetadataPath, '{not json');

    expect(readPipelineLocalMetadata(USER_LOCATOR)).toEqual({});
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse metadata file'),
    );
  });

  it('leaves a file it cannot read unchanged instead of dropping its owners', () => {
    fs.mkdirSync(path.dirname(mockMetadataPath), { recursive: true });
    fs.writeFileSync(mockMetadataPath, '{not json');

    recordUserPipelineOwner('pipeline-1', 'personal');
    deleteUserPipelineLocalMetadata('pipeline-1');

    expect(fs.readFileSync(mockMetadataPath, 'utf8')).toBe('{not json');
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Metadata file is unreadable'),
    );
  });

  it('reports whether stored owners can be read', () => {
    expect(isPipelineLocalMetadataReadable()).toBe(true);
    fs.mkdirSync(path.dirname(mockMetadataPath), { recursive: true });
    fs.writeFileSync(mockMetadataPath, '{not json');
    expect(isPipelineLocalMetadataReadable()).toBe(false);
  });

  it('parses the file once across repeated reads and sees a replaced file', () => {
    recordUserPipelineOwner('pipeline-1', 'personal');
    const read = jest.mocked(fs.readFileSync);
    read.mockClear();
    for (let i = 0; i < 3; i += 1)
      expect(readPipelineLocalMetadata(USER_LOCATOR)).toEqual({
        owner: 'personal',
      });
    expect(
      read.mock.calls.filter(([file]) => file === mockMetadataPath),
    ).toHaveLength(0);

    fs.writeFileSync(
      mockMetadataPath,
      JSON.stringify({
        version: 1,
        entries: {
          'stored:user:pipeline-1': {
            owner: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          },
        },
      }),
    );
    // Same size as the store's own write; a later mtime marks the change
    // without depending on the file system's timestamp resolution.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(mockMetadataPath, later, later);
    expect(readPipelineLocalMetadata(USER_LOCATOR)).toEqual({
      owner: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
  });

  it('retries a read that failed for a transient reason', () => {
    recordUserPipelineOwner('pipeline-1', 'personal');
    // A later mtime forces a fresh read, which fails once.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(mockMetadataPath, later, later);
    jest.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('too many open files'), {
        code: 'EMFILE',
      });
    });

    expect(isPipelineLocalMetadataReadable()).toBe(false);
    expect(readPipelineLocalMetadata(USER_LOCATOR)).toEqual({
      owner: 'personal',
    });
  });

  it('leaves no temporary file behind after a write', () => {
    recordUserPipelineOwner('pipeline-1', 'personal');

    expect(fs.readdirSync(path.dirname(mockMetadataPath))).toEqual([
      'pipeline-local-metadata.json',
    ]);
  });

  it('drops malformed entry fields', () => {
    fs.mkdirSync(path.dirname(mockMetadataPath), { recursive: true });
    fs.writeFileSync(
      mockMetadataPath,
      JSON.stringify({
        version: 1,
        entries: {
          'stored:user:pipeline-1': {
            owner: 'not-a-context',
            agentAuthor: { chat: { projectId: 'p' }, recordedAt: 'now' },
          },
        },
      }),
    );

    expect(readPipelineLocalMetadata(USER_LOCATOR)).toEqual({});
  });

  it('does not throw when the file cannot be written', () => {
    const dataDir = path.dirname(mockMetadataPath);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.chmodSync(dataDir, 0o500);

    try {
      expect(() =>
        recordUserPipelineOwner('pipeline-1', 'personal'),
      ).not.toThrow();
    } finally {
      fs.chmodSync(dataDir, 0o700);
    }
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write metadata file'),
    );
  });
});
