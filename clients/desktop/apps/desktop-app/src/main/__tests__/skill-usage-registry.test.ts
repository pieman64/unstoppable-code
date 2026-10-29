import type * as AtomicFileModule from '../lib/atomic-file';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shareTargetKey } from '@canopy/desktop-shared/lib/skill-share-nudge';
import { writeFileAtomically } from '../lib/atomic-file';
let mockPath: string;
jest.mock('../lib/paths', () => ({
  getSkillUsageFilePath: (): string => mockPath,
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(
    jest.requireActual<typeof AtomicFileModule>('../lib/atomic-file')
      .writeFileAtomically,
  ),
}));
import {
  readSkillUsage,
  recordSkillUse,
  resolveSkillShareNudge,
} from '../lib/skill-usage-registry';
const key = shareTargetKey({
  kind: 'skill',
  sourceId: 'custom:app',
  name: 'test',
});
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-usage-test-'));
  mockPath = join(dir, 'skill-usage.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('machine-local skill usage registry', () => {
  it('counts serialized uses and keeps retrying above threshold until resolved', async () => {
    const uses = await Promise.all(
      Array.from({ length: 7 }, () => recordSkillUse(key)),
    );
    expect(uses.map((use) => use.shouldEvaluateNudge)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect((await readSkillUsage()).items[key]?.count).toBe(7);
    const persisted: unknown = JSON.parse(await readFile(mockPath, 'utf8'));
    expect(persisted).toEqual({ version: 1, items: { [key]: { count: 7 } } });
    await resolveSkillShareNudge(key, 'shown');
    expect((await recordSkillUse(key)).shouldEvaluateNudge).toBe(false);
    expect((await readSkillUsage()).items[key]?.count).toBe(7);
  });
  it('allows shown to become dismissed/shared without downgrading terminal states', async () => {
    await recordSkillUse(key);
    await resolveSkillShareNudge(key, 'shown');
    await resolveSkillShareNudge(key, 'dismissed');
    const dismissed = (await readSkillUsage()).items[key];
    await Promise.all([
      resolveSkillShareNudge(key, 'shown'),
      resolveSkillShareNudge(key, 'shared'),
      recordSkillUse(key),
    ]);
    expect((await readSkillUsage()).items[key]).toEqual(dismissed);
    const other = shareTargetKey({
      kind: 'plugin',
      marketplaceId: 'm',
      pluginName: 'p',
    });
    await resolveSkillShareNudge(other, 'shown');
    await resolveSkillShareNudge(other, 'shared');
    expect((await readSkillUsage()).items[other]?.nudge).toBe('shared');
  });
  it('reads missing/corrupt/unsupported files as empty and drops malformed entries', async () => {
    expect((await readSkillUsage()).items).toEqual({});
    for (const content of [
      '{',
      '{"version":2,"items":{}}',
      '{"version":1,"items":null}',
    ]) {
      await writeFile(mockPath, content);
      expect((await readSkillUsage()).items).toEqual({});
    }
    for (const item of [
      { count: -1 },
      { count: 1.5 },
      { count: '1' },
      { count: Infinity },
      { count: 1, nudge: 'bad' },
      { count: 1, resolvedAt: 'bad' },
    ]) {
      await writeFile(
        mockPath,
        JSON.stringify({ version: 1, items: { [key]: item } }),
      );
      expect((await readSkillUsage()).items).toEqual({});
    }
    await writeFile(
      mockPath,
      JSON.stringify({
        version: 1,
        items: { bad: { count: 5 }, [key]: { count: 4 } },
      }),
    );
    expect((await readSkillUsage()).items).toEqual({ [key]: { count: 4 } });
  });
  it('does not acknowledge failed writes and keeps the chain retryable', async () => {
    jest
      .mocked(writeFileAtomically)
      .mockRejectedValueOnce(new Error('disk failure'));
    await expect(recordSkillUse(key)).rejects.toThrow('disk failure');
    await recordSkillUse(key);
    jest
      .mocked(writeFileAtomically)
      .mockRejectedValueOnce(new Error('disk failure'));
    await expect(resolveSkillShareNudge(key, 'shown')).rejects.toThrow(
      'disk failure',
    );
    expect((await readSkillUsage()).items[key]?.nudge).toBeUndefined();
    await resolveSkillShareNudge(key, 'shown');
    expect((await readSkillUsage()).items[key]?.nudge).toBe('shown');
    await expect(recordSkillUse('arbitrary')).rejects.toThrow('Invalid');
  });
});
