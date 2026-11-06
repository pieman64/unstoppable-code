// Persistence contract behind detected-plans:scan and detected-plans:update.
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DetectedPlanEntry } from '@canopy/desktop-shared/types';
import { resolveDetectedPlansFilePath } from '../lib/resolve-worktree';
import {
  appendDetectedPlans,
  deleteDetectedPlansForWorktree,
  markBannerSeenForChat,
  readDetectedPlans,
  updateDetectedPlan,
} from '../lib/detected-plan-persistence';

jest.mock('../lib/resolve-worktree', () => ({
  resolveDetectedPlansFilePath: jest.fn(),
}));

const projectId = 'project';
const worktreeId = 'worktree';
function entry(
  id: string,
  patch: Partial<DetectedPlanEntry> = {},
): DetectedPlanEntry {
  return {
    id,
    sourceRepoId: 'repo',
    sourceFilePath: `${id}.md`,
    status: 'detected',
    bannerSeen: false,
    detectedInChatId: 'chat',
    detectedAt: '2026-11-06T00:00:00.000Z',
    ...patch,
  };
}

const mutations = [
  {
    name: 'append',
    run: (): Promise<DetectedPlanEntry[]> =>
      appendDetectedPlans(projectId, worktreeId, [entry('new')]),
  },
  {
    name: 'empty append',
    run: (): Promise<DetectedPlanEntry[]> =>
      appendDetectedPlans(projectId, worktreeId, []),
  },
  {
    name: 'update',
    run: (): Promise<DetectedPlanEntry[]> =>
      updateDetectedPlan(projectId, worktreeId, 'old', { status: 'dismissed' }),
  },
  {
    name: 'unmatched update',
    run: (): Promise<DetectedPlanEntry[]> =>
      updateDetectedPlan(projectId, worktreeId, 'absent', {}),
  },
  {
    name: 'banner update',
    run: (): Promise<DetectedPlanEntry[]> =>
      markBannerSeenForChat(projectId, worktreeId, 'chat'),
  },
  {
    name: 'delete',
    run: (): Promise<void> =>
      deleteDetectedPlansForWorktree(projectId, worktreeId),
  },
];

let root: string;
let filePath: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'detected-plan-contract-'));
  filePath = join(root, 'detected-plans.json');
  jest.mocked(resolveDetectedPlansFilePath).mockReturnValue(filePath);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe.each([
  { name: 'empty file', raw: '' },
  { name: 'whitespace-only file', raw: ' \n\t' },
  { name: 'malformed JSON', raw: '{"version": 1, "entries": [' },
  { name: 'null', raw: 'null' },
  { name: 'missing version', raw: '{"entries": []}' },
  { name: 'older version', raw: '{"version": 0, "entries": []}' },
  {
    name: 'newer version',
    raw: JSON.stringify({
      version: 2,
      entries: [entry('old')],
      future: 'retained',
    }),
  },
  { name: 'invalid entries', raw: '{"version": 1, "entries": {}}' },
  {
    name: 'partially damaged entries',
    raw: JSON.stringify({
      version: 1,
      entries: [entry('old'), { id: 'broken' }],
    }),
  },
  {
    name: 'invalid status',
    raw: JSON.stringify({
      version: 1,
      entries: [{ ...entry('old'), status: 'unknown' }],
    }),
  },
])('$name', ({ raw }) => {
  test.each(mutations)(
    '$name refuses and preserves exact bytes; display still falls back',
    async ({ run }) => {
      const bytes = Buffer.from(raw);
      await fs.writeFile(filePath, bytes);
      await expect(readDetectedPlans(projectId, worktreeId)).resolves.toEqual(
        [],
      );
      await expect(run()).rejects.toThrow();
      expect(await fs.readFile(filePath)).toEqual(bytes);
    },
  );
});

describe.each(['EACCES', 'EPERM', 'EIO'])('unreadable state (%s)', (code) => {
  test.each(mutations)(
    '$name refuses without modifying a readable fixture',
    async ({ run }) => {
      const bytes = Buffer.from(
        `{ "version": 1, "entries": ${JSON.stringify([entry('old')])} }\n`,
      );
      await fs.writeFile(filePath, bytes);
      const error = Object.assign(new Error('Injected read failure'), { code });
      const read = jest.spyOn(fs, 'readFile');
      read.mockRejectedValueOnce(error);
      await expect(readDetectedPlans(projectId, worktreeId)).resolves.toEqual(
        [],
      );
      read.mockRejectedValueOnce(error);
      await expect(run()).rejects.toBe(error);
      read.mockRestore();
      expect(await fs.readFile(filePath)).toEqual(bytes);
    },
  );
});

test.each(mutations)(
  '$name refuses invalid UTF-8 without changing bytes or display behavior',
  async ({ run }) => {
    const raw = JSON.stringify({ version: 1, entries: [entry('old')] });
    const pathOffset = raw.indexOf('old.md');
    const damaged = Buffer.concat([
      Buffer.from(raw.slice(0, pathOffset)),
      Buffer.from([0xff]),
      Buffer.from(raw.slice(pathOffset + 'old.md'.length)),
    ]);
    await fs.writeFile(filePath, damaged);
    await expect(readDetectedPlans(projectId, worktreeId)).resolves.toEqual([
      entry('old', { sourceFilePath: '\uFFFD' }),
    ]);
    await expect(run()).rejects.toThrow();
    expect(await fs.readFile(filePath)).toEqual(damaged);
  },
);

test.each(mutations)(
  '$name refuses an unreadable directory without removing its evidence',
  async ({ run }) => {
    await fs.mkdir(filePath);
    const evidence = join(filePath, 'evidence');
    await fs.writeFile(evidence, 'preserve');
    await expect(readDetectedPlans(projectId, worktreeId)).resolves.toEqual([]);
    await expect(run()).rejects.toThrow();
    expect(await fs.readFile(evidence, 'utf8')).toBe('preserve');
  },
);

test('missing state remains empty and all empty mutations stay usable', async () => {
  await expect(readDetectedPlans(projectId, worktreeId)).resolves.toEqual([]);
  await expect(appendDetectedPlans(projectId, worktreeId, [])).resolves.toEqual(
    [],
  );
  await expect(
    updateDetectedPlan(projectId, worktreeId, 'absent', {}),
  ).resolves.toEqual([]);
  await expect(
    markBannerSeenForChat(projectId, worktreeId, 'chat'),
  ).resolves.toEqual([]);
  await deleteDetectedPlansForWorktree(projectId, worktreeId);
  await expect(fs.readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('healthy mutations retain tuple deduplication, existing identity, order and patches', async () => {
  const old = entry('old', { status: 'imported', importedPlanId: 'plan' });
  const samePathOtherRepo = entry('other-repo', {
    sourceFilePath: old.sourceFilePath,
    sourceRepoId: 'other',
  });
  const next = entry('next');
  const otherChat = entry('other-chat', { detectedInChatId: 'other-chat' });
  await expect(
    appendDetectedPlans(projectId, worktreeId, [old]),
  ).resolves.toEqual([old]);
  await expect(
    appendDetectedPlans(projectId, worktreeId, [
      entry('duplicate', { sourceFilePath: old.sourceFilePath }),
      samePathOtherRepo,
      next,
      otherChat,
    ]),
  ).resolves.toEqual([old, samePathOtherRepo, next, otherChat]);
  const patched = {
    ...next,
    status: 'dismissed',
    bannerSeen: true,
    importedPlanId: 'linked',
  };
  await expect(
    updateDetectedPlan(projectId, worktreeId, next.id, {
      status: 'dismissed',
      bannerSeen: true,
      importedPlanId: 'linked',
    }),
  ).resolves.toEqual([old, samePathOtherRepo, patched, otherChat]);
  const expected = [
    old,
    { ...samePathOtherRepo, bannerSeen: true },
    patched,
    otherChat,
  ];
  await expect(
    markBannerSeenForChat(projectId, worktreeId, 'chat'),
  ).resolves.toEqual(expected);
  await expect(readDetectedPlans(projectId, worktreeId)).resolves.toEqual(
    expected,
  );
  await expect(
    updateDetectedPlan(projectId, worktreeId, 'absent', {}),
  ).resolves.toEqual(expected);
  await deleteDetectedPlansForWorktree(projectId, worktreeId);
  await expect(fs.readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a refusal releases the queue so externally repaired state can be mutated', async () => {
  await fs.writeFile(filePath, '{bad');
  await expect(
    appendDetectedPlans(projectId, worktreeId, [entry('new')]),
  ).rejects.toThrow();
  await fs.writeFile(
    filePath,
    JSON.stringify({ version: 1, entries: [entry('old')] }),
  );
  await expect(
    appendDetectedPlans(projectId, worktreeId, [entry('new')]),
  ).resolves.toEqual([entry('old'), entry('new')]);
});

test('valid UTF-8 paths, including literal replacement characters, stay mutable', async () => {
  const old = entry('old', { sourceFilePath: 'plans/�-日本-🌳.md' });
  await fs.writeFile(filePath, JSON.stringify({ version: 1, entries: [old] }));
  await expect(
    appendDetectedPlans(projectId, worktreeId, [entry('new')]),
  ).resolves.toEqual([old, entry('new')]);
  const expected = [{ ...old, bannerSeen: true }, entry('new')];
  await expect(
    updateDetectedPlan(projectId, worktreeId, old.id, { bannerSeen: true }),
  ).resolves.toEqual(expected);
  await expect(readDetectedPlans(projectId, worktreeId)).resolves.toEqual(
    expected,
  );
  await deleteDetectedPlansForWorktree(projectId, worktreeId);
  await expect(fs.readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('append, delete and append share per-file queue ordering', async () => {
  await Promise.all([
    appendDetectedPlans(projectId, worktreeId, [entry('first')]),
    deleteDetectedPlansForWorktree(projectId, worktreeId),
    appendDetectedPlans(projectId, worktreeId, [entry('last')]),
  ]);
  await expect(readDetectedPlans(projectId, worktreeId)).resolves.toEqual([
    entry('last'),
  ]);
});
