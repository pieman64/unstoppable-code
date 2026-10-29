import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openCodeCapabilityDigest,
  openCodeCapabilityFiles,
  forkOpenCodeCapabilityBinding,
  readOpenCodeCapabilityBinding,
  saveOpenCodeCapabilitySnapshot,
  type OpenCodeCapabilitySnapshot,
} from '../capability-snapshot';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opencode-capabilities-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('hashes the delivered bytes, including hidden files, even when size and mtime match', async () => {
  const file = join(root, '.selected');
  await writeFile(file, 'first');
  const info = await stat(file);
  const before = await openCodeCapabilityFiles(
    [root],
    AbortSignal.timeout(5000),
  );
  await writeFile(file, 'other');
  await utimes(file, info.atime, info.mtime);
  expect(
    await openCodeCapabilityFiles([root], AbortSignal.timeout(5000)),
  ).not.toEqual(before);
  expect(Object.keys(before)).toEqual(['0/.selected']);
});

it('rejects linked capability roots and files instead of following them', async () => {
  await mkdir(join(root, 'files'));
  await writeFile(join(root, 'secret'), 'not selected');
  await symlink(join(root, 'secret'), join(root, 'files', 'linked'));
  await expect(
    openCodeCapabilityFiles([join(root, 'files')], AbortSignal.timeout(5000)),
  ).rejects.toThrow('symbolic link');
});

it('persists immutable generations, detects tampering and never stores hashed context', async () => {
  const snapshot: OpenCodeCapabilitySnapshot = {
    version: 1,
    runtime: { pin: 'fixture' },
    files: {},
    mcp: [],
    contextDigest: openCodeCapabilityDigest({ credential: 'private-secret' }),
    providerSettingsDigest: openCodeCapabilityDigest({ selected: 'fixture' }),
  };
  const signal = AbortSignal.timeout(5000);
  const first = await saveOpenCodeCapabilitySnapshot(
    root,
    'session',
    snapshot,
    undefined,
    signal,
  );
  expect(await readOpenCodeCapabilityBinding(root, 'session')).toEqual(first);
  const same = await saveOpenCodeCapabilitySnapshot(
    root,
    'session',
    snapshot,
    first,
    signal,
  );
  expect(same.generation).toBe(1);
  const changed = await saveOpenCodeCapabilitySnapshot(
    root,
    'session',
    { ...snapshot, files: { command: 'new hash' } },
    same,
    signal,
  );
  expect(changed.generation).toBe(2);
  const file = join(root, 'capability-snapshots', `${changed.digest}.json`);
  expect(await readFile(file, 'utf8')).not.toContain('private-secret');
  await writeFile(file, '{"version":1}');
  await expect(readOpenCodeCapabilityBinding(root, 'session')).rejects.toThrow(
    'changed on disk',
  );
  expect(await readOpenCodeCapabilityBinding(root, 'legacy')).toBeUndefined();
});

it('rejects future bindings and cancellation before publication', async () => {
  const snapshot: OpenCodeCapabilitySnapshot = {
    version: 1,
    runtime: {},
    files: {},
    mcp: [],
    contextDigest: '',
    providerSettingsDigest: '',
  };
  await expect(
    saveOpenCodeCapabilitySnapshot(
      root,
      'cancelled',
      snapshot,
      undefined,
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
  expect(
    await readOpenCodeCapabilityBinding(root, 'cancelled'),
  ).toBeUndefined();
  await mkdir(join(root, 'capability-bindings'), { recursive: true });
  await writeFile(
    join(
      root,
      'capability-bindings',
      `${openCodeCapabilityDigest('future')}.json`,
    ),
    JSON.stringify({ version: 2, sessionId: 'future' }),
  );
  await expect(readOpenCodeCapabilityBinding(root, 'future')).rejects.toThrow(
    'binding is invalid',
  );
});

it('copies a verified capability manifest to a distinct native fork binding', async () => {
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  const signal = AbortSignal.timeout(5000);
  const snapshot: OpenCodeCapabilitySnapshot = {
    version: 1,
    runtime: { version: '1.18.34' },
    files: { 'skill.md': 'original-digest' },
    mcp: [],
    contextDigest: 'source-context',
    providerSettingsDigest: 'source-settings',
  };
  const original = await saveOpenCodeCapabilitySnapshot(
    source,
    'source-session',
    snapshot,
    undefined,
    signal,
  );
  await expect(
    forkOpenCodeCapabilityBinding(
      source,
      'source-session',
      source,
      'fork-session',
      signal,
    ),
  ).rejects.toThrow('distinct');
  await expect(
    forkOpenCodeCapabilityBinding(
      source,
      'source-session',
      destination,
      'source-session',
      signal,
    ),
  ).rejects.toThrow('distinct');
  const forked = await forkOpenCodeCapabilityBinding(
    source,
    'source-session',
    destination,
    'fork-session',
    signal,
  );
  expect(forked).toEqual({ ...original, sessionId: 'fork-session' });
  expect(
    await readOpenCodeCapabilityBinding(destination, 'fork-session'),
  ).toEqual(forked);
  expect(
    await readOpenCodeCapabilityBinding(destination, 'source-session'),
  ).toBeUndefined();
  expect(await readOpenCodeCapabilityBinding(source, 'source-session')).toEqual(
    original,
  );
  expect(
    await readFile(
      join(destination, 'capability-snapshots', `${original.digest}.json`),
      'utf8',
    ),
  ).toBe(
    await readFile(
      join(source, 'capability-snapshots', `${original.digest}.json`),
      'utf8',
    ),
  );
  // A changed selection on the destination's first turn still gets a new generation.
  expect(
    (
      await saveOpenCodeCapabilitySnapshot(
        destination,
        'fork-session',
        { ...snapshot, contextDigest: 'destination-context' },
        forked,
        signal,
      )
    ).generation,
  ).toBe(2);
});

it('refuses to fork absent or tampered capability history', async () => {
  const destination = join(root, 'destination');
  const signal = AbortSignal.timeout(5000);
  await expect(
    forkOpenCodeCapabilityBinding(root, 'absent', destination, 'fork', signal),
  ).rejects.toThrow('capability');
  const binding = await saveOpenCodeCapabilitySnapshot(
    root,
    'source',
    {
      version: 1,
      runtime: {},
      files: {},
      mcp: [],
      contextDigest: '',
      providerSettingsDigest: '',
    },
    undefined,
    signal,
  );
  await writeFile(
    join(root, 'capability-snapshots', `${binding.digest}.json`),
    '{"version":1}',
  );
  await expect(
    forkOpenCodeCapabilityBinding(root, 'source', destination, 'fork', signal),
  ).rejects.toThrow('changed on disk');
  expect(
    await readOpenCodeCapabilityBinding(destination, 'fork'),
  ).toBeUndefined();
});
