// CAN-3807: the typed workspace metadata and ordering boundary. Runs the real
// sidebar and persistence modules against a temporary data dir.
const mockRecordAppDiagnostic = jest.fn();
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CoworkSidebarItem,
  MultiRepoSidebarItem,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import { serializeChatProjectOperation } from '../chat-project-operation-queue';
import { recordWorkspaceCrudTelemetry } from '../desktop-telemetry';
import {
  getWorkspaceConfigPath,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreesFilePath,
} from '../paths';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  writeAllSidebarItems,
} from '../sidebar-items';
import {
  reorderWorkspaces,
  updateWorkspaceMetadata,
  WorkspaceMetadataRefusedError,
  type WorkspaceMetadataPatch,
} from '../workspace-metadata';

const mockedNotify = jest.mocked(notifyPortalStructureChanged);
const mockedTelemetry = jest.mocked(recordWorkspaceCrudTelemetry);

function coworkItem(id: string, order: number): CoworkSidebarItem {
  return {
    id,
    name: `Project ${id}`,
    type: 'cowork',
    color: '#7C3AED',
    collapsed: false,
    order,
    cowork: { createdAt: '2026-09-01T00:00:00.000Z' },
  };
}

function multiRepoItem(id: string, order: number): MultiRepoSidebarItem {
  return {
    id,
    name: `Project ${id}`,
    type: 'multi-repo',
    color: '#0EA5E9',
    collapsed: false,
    order,
    repos: [],
    worktrees: [
      {
        id: `${id}-tree`,
        branchName: `${id}-branch`,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  };
}

const SEEDED: SidebarItem[] = [
  coworkItem('alpha', 0),
  coworkItem('beta', 1),
  multiRepoItem('gamma', 2),
];

/** An entry this version cannot read, as a newer app could write. */
const FUTURE_ENTRY = {
  id: 'future',
  name: 'Future',
  type: 'notebook',
  color: '#000000',
  collapsed: false,
  order: 9,
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`Expected an object at ${filePath}`);
  return parsed;
}

async function readIndexEntries(): Promise<JsonRecord[]> {
  const workspaces = (await readJson(getWorkspaceIndexFilePath())).workspaces;
  if (!Array.isArray(workspaces)) throw new Error('Expected an index');
  return workspaces.filter(isRecord);
}

async function readIndexEntry(id: string): Promise<JsonRecord | undefined> {
  return (await readIndexEntries()).find((entry) => entry.id === id);
}

/** Adds fields and an entry this version does not know (CAN-3800). */
async function addUnknownIndexData(): Promise<void> {
  const index = await readJson(getWorkspaceIndexFilePath());
  const entries = await readIndexEntries();
  await writeFile(
    getWorkspaceIndexFilePath(),
    JSON.stringify({
      ...index,
      futureTopLevel: { enabled: true },
      workspaces: [
        ...entries.map((entry) =>
          entry.id === 'alpha' ? { ...entry, futureField: 'kept' } : entry,
        ),
        FUTURE_ENTRY,
      ],
    }),
  );
}

async function inode(filePath: string): Promise<number> {
  return (await stat(filePath)).ino;
}

/** The identity of every manifest and worktree list, to prove none moved. */
async function workspaceFileInodes(): Promise<Record<string, number>> {
  return {
    alpha: await inode(getWorkspaceConfigPath('alpha')),
    beta: await inode(getWorkspaceConfigPath('beta')),
    gamma: await inode(getWorkspaceConfigPath('gamma')),
    gammaWorktrees: await inode(getWorkspaceWorktreesFilePath('gamma')),
  };
}

async function expectRefusal(
  promise: Promise<unknown>,
  reason: WorkspaceMetadataRefusedError['reason'],
  message: RegExp,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspaceMetadataRefusedError);
  expect(error).toMatchObject({ reason });
  expect(error instanceof Error ? error.message : '').toMatch(message);
}

/** A patch carrying a value its type rules out, as an untyped IPC payload can. */
function untrustedPatch(
  field: keyof WorkspaceMetadataPatch,
  value: unknown,
): WorkspaceMetadataPatch {
  const patch: WorkspaceMetadataPatch = {};
  Reflect.set(patch, field, value);
  return patch;
}

function update(
  workspaceId: string,
  patch: WorkspaceMetadataPatch,
): ReturnType<typeof updateWorkspaceMetadata> {
  return updateWorkspaceMetadata({ workspaceId, patch, source: 'portal' });
}

describe('workspace metadata boundary (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-metadata-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems(SEEDED);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('updateWorkspaceMetadata', () => {
    it('renames and recolors by rewriting only the index entry (F12)', async () => {
      const before = await workspaceFileInodes();

      const outcome = await update('alpha', {
        name: '  Renamed  ',
        color: '#22C55E',
      });

      expect(outcome).toEqual({
        workspaceId: 'alpha',
        indexWritten: true,
        manifestWritten: false,
      });
      expect(await readIndexEntry('alpha')).toMatchObject({
        name: 'Renamed',
        color: '#22C55E',
      });
      expect(await workspaceFileInodes()).toEqual(before);
      expect(mockedTelemetry).toHaveBeenCalledWith({
        action: 'update',
        workspaceId: 'alpha',
        source: 'portal',
      });
      expect(mockedNotify).toHaveBeenCalledTimes(1);
    });

    it('round-trips every typed field through the sidebar projection', async () => {
      await update('gamma', {
        name: 'Gamma',
        color: '#22C55E',
        pinned: true,
        collapsed: true,
        itemSortMode: 'last-updated',
        activitySectionOrder: ['plans', 'summary'],
        alwaysShow: false,
        startPage: { kind: 'set', startPage: { kind: 'file', path: 'a.md' } },
      });

      const gamma = (await readAllSidebarItems()).items.find(
        (item) => item.id === 'gamma',
      );
      expect(gamma).toMatchObject({
        name: 'Gamma',
        color: '#22C55E',
        pinned: true,
        collapsed: true,
        itemSortMode: 'last-updated',
        activitySectionOrder: ['plans', 'summary'],
        alwaysShow: false,
        startPage: { kind: 'file', path: 'a.md' },
      });
    });

    it('keeps unknown fields, unreadable entries and every other workspace', async () => {
      await addUnknownIndexData();

      await update('alpha', { name: 'Renamed', pinned: true });

      const index = await readJson(getWorkspaceIndexFilePath());
      expect(index.futureTopLevel).toEqual({ enabled: true });
      expect((await readIndexEntries()).map((entry) => entry.id)).toEqual([
        'alpha',
        'beta',
        'gamma',
        'future',
      ]);
      expect(await readIndexEntry('alpha')).toMatchObject({
        name: 'Renamed',
        pinned: true,
        futureField: 'kept',
      });
      expect(await readIndexEntry('future')).toEqual(FUTURE_ENTRY);
    });

    it('clears a pin and an activity order deliberately', async () => {
      await update('gamma', {
        pinned: true,
        activitySectionOrder: ['plans'],
      });

      await update('gamma', { pinned: false, activitySectionOrder: [] });

      const gamma = await readIndexEntry('gamma');
      expect(gamma).not.toHaveProperty('pinned');
      expect(gamma).not.toHaveProperty('activitySectionOrder');
    });

    it('never persists an activity order for a Cowork workspace', async () => {
      await update('alpha', { activitySectionOrder: ['plans'] });

      expect(await readIndexEntry('alpha')).not.toHaveProperty(
        'activitySectionOrder',
      );
    });

    it('writes manifest fields into that workspace manifest only', async () => {
      const manifestPath = getWorkspaceConfigPath('gamma');
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...(await readJson(manifestPath)),
          futureManifestField: 'kept',
        }),
      );
      const before = await workspaceFileInodes();
      const indexBefore = await inode(getWorkspaceIndexFilePath());

      const outcome = await update('gamma', {
        itemSortMode: 'last-updated',
        alwaysShow: false,
      });

      expect(outcome).toEqual({
        workspaceId: 'gamma',
        indexWritten: false,
        manifestWritten: true,
      });
      expect(await readJson(manifestPath)).toMatchObject({
        itemSortMode: 'last-updated',
        alwaysShow: false,
        futureManifestField: 'kept',
      });
      expect(await inode(getWorkspaceIndexFilePath())).toBe(indexBefore);
      const after = await workspaceFileInodes();
      expect(after.alpha).toBe(before.alpha);
      expect(after.beta).toBe(before.beta);
      expect(after.gammaWorktrees).toBe(before.gammaWorktrees);
      // Sort mode and visibility are view preferences.
      expect(mockedTelemetry).not.toHaveBeenCalled();
      expect(mockedNotify).toHaveBeenCalledTimes(1);
    });

    it('sets, disables and inherits the start page override', async () => {
      const manifestPath = getWorkspaceConfigPath('gamma');
      const startPage = { kind: 'url', url: 'https://example.com/' } as const;

      await update('gamma', { startPage: { kind: 'set', startPage } });
      expect((await readJson(manifestPath)).startPage).toEqual(startPage);

      await update('gamma', { startPage: { kind: 'set', startPage: null } });
      expect(await readJson(manifestPath)).toHaveProperty('startPage', null);

      await update('gamma', { startPage: { kind: 'inherit' } });
      expect(await readJson(manifestPath)).not.toHaveProperty('startPage');
    });

    it('keeps the start page for an unknown start page change', async () => {
      const manifestPath = getWorkspaceConfigPath('gamma');
      const startPage = { kind: 'url', url: 'https://example.com/' } as const;
      await update('gamma', { startPage: { kind: 'set', startPage } });

      expect(
        await update('gamma', untrustedPatch('startPage', { kind: 'clear' })),
      ).toEqual({
        workspaceId: 'gamma',
        indexWritten: false,
        manifestWritten: true,
      });
      expect((await readJson(manifestPath)).startPage).toEqual(startPage);
    });

    it.each<[string, WorkspaceMetadataPatch]>([
      ['an empty patch', {}],
      ['a patch of undefined fields', { collapsed: undefined }],
    ])('does nothing for %s', async (_label, patch) => {
      const before = await inode(getWorkspaceIndexFilePath());

      expect(await update('alpha', patch)).toEqual({
        workspaceId: 'alpha',
        indexWritten: false,
        manifestWritten: false,
      });
      expect(await inode(getWorkspaceIndexFilePath())).toBe(before);
      expect(mockedNotify).not.toHaveBeenCalled();
    });

    it('waits for an in-flight workspace mutation before reading', async () => {
      let releaseInstall = (): void => {};
      const installGate = new Promise<void>((resolve) => {
        releaseInstall = resolve;
      });
      const install = serializeChatProjectOperation(async () => {
        await installGate;
        await update('beta', { name: 'Installed' });
      });

      const pending = update('beta', { color: '#22C55E' });
      releaseInstall();
      await Promise.all([install, pending]);

      expect(await readIndexEntry('beta')).toMatchObject({
        name: 'Installed',
        color: '#22C55E',
      });
    });

    it('never creates a missing manifest', async () => {
      await rm(getWorkspaceConfigPath('gamma'));

      await expectRefusal(
        update('gamma', { name: 'Renamed', alwaysShow: false }),
        'configuration-unavailable',
        /settings could not be read/,
      );
      await expect(stat(getWorkspaceConfigPath('gamma'))).rejects.toThrow();
      expect(await readIndexEntry('gamma')).toMatchObject({
        name: 'Project gamma',
      });
    });

    describe('refusals write nothing', () => {
      let before: Record<string, number>;
      let indexBefore: number;

      beforeEach(async () => {
        before = await workspaceFileInodes();
        indexBefore = await inode(getWorkspaceIndexFilePath());
      });

      afterEach(async () => {
        expect(await workspaceFileInodes()).toEqual(before);
        expect(await inode(getWorkspaceIndexFilePath())).toBe(indexBefore);
        expect(mockedNotify).not.toHaveBeenCalled();
        expect(mockedTelemetry).not.toHaveBeenCalled();
      });

      it.each<[string, WorkspaceMetadataPatch, RegExp]>([
        ['a blank name', { name: '   ' }, /name cannot be empty/i],
        ['a color outside the palette', { color: '#000000' }, /color/i],
        [
          'an unknown sort mode',
          untrustedPatch('itemSortMode', 'newest'),
          /sort mode/i,
        ],
        [
          'an unknown activity section',
          untrustedPatch('activitySectionOrder', ['nope']),
          /activity section/i,
        ],
        [
          'a repeated activity section',
          { activitySectionOrder: ['plans', 'plans'] },
          /activity section/i,
        ],
        [
          'an invalid start page',
          {
            startPage: {
              kind: 'set',
              startPage: { kind: 'file', path: '/absolute.md' },
            },
          },
          /start page/i,
        ],
      ])('refuses %s', async (_label, patch, message) => {
        await expectRefusal(update('gamma', patch), 'invalid-patch', message);
      });

      it('refuses an unknown workspace', async () => {
        await expectRefusal(
          update('missing', { name: 'x' }),
          'not-found',
          /Project missing not found\./,
        );
      });

      it('refuses a start page for a Cowork workspace', async () => {
        await expectRefusal(
          update('alpha', {
            name: 'Renamed',
            startPage: { kind: 'inherit' },
          }),
          'unsupported-for-cowork',
          /managed through cowork settings/,
        );
      });

      it('refuses a manifest field while the manifest is unreadable', async () => {
        await writeFile(getWorkspaceConfigPath('gamma'), '{"version": 1, ');
        before.gamma = await inode(getWorkspaceConfigPath('gamma'));

        await expectRefusal(
          update('gamma', { name: 'Renamed', itemSortMode: 'last-updated' }),
          'configuration-unavailable',
          /settings could not be read/,
        );
        expect(await readIndexEntry('gamma')).toMatchObject({
          name: 'Project gamma',
        });
      });

      it('refuses while the index is unreadable', async () => {
        await writeFile(getWorkspaceIndexFilePath(), '{"version": 1, "work');
        indexBefore = await inode(getWorkspaceIndexFilePath());

        await expectRefusal(
          update('alpha', { name: 'Renamed' }),
          'index-unavailable',
          /project list couldn't be read/,
        );
        expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(
          '{"version": 1, "work',
        );
      });
    });
  });

  describe('reorderWorkspaces', () => {
    it('moves only the visible slots and rewrites only the index', async () => {
      await addUnknownIndexData();
      const before = await workspaceFileInodes();

      const outcome = await reorderWorkspaces({
        visibleWorkspaceIds: ['alpha', 'gamma'],
        activeWorkspaceId: 'gamma',
        overWorkspaceId: 'alpha',
      });

      expect(outcome).toEqual({ workspaceIds: ['gamma', 'beta', 'alpha'] });
      const entries = await readIndexEntries();
      expect(entries.map((entry) => [entry.id, entry.order])).toEqual([
        ['gamma', 0],
        ['beta', 1],
        ['alpha', 2],
        ['future', 9],
      ]);
      expect(entries.find((entry) => entry.id === 'alpha')).toMatchObject({
        futureField: 'kept',
      });
      expect(await workspaceFileInodes()).toEqual(before);
      expect(mockedNotify).toHaveBeenCalledTimes(1);
    });

    it('refuses a workspace that is not visible', async () => {
      const indexBefore = await inode(getWorkspaceIndexFilePath());

      await expectRefusal(
        reorderWorkspaces({
          visibleWorkspaceIds: ['alpha', 'gamma'],
          activeWorkspaceId: 'beta',
          overWorkspaceId: 'alpha',
        }),
        'not-found',
        /^Project to reorder was not found\.$/,
      );
      expect(await inode(getWorkspaceIndexFilePath())).toBe(indexBefore);
      expect(mockedNotify).not.toHaveBeenCalled();
    });

    it('refuses while the index is unreadable', async () => {
      await writeFile(getWorkspaceIndexFilePath(), '{"version": 1, "work');

      await expectRefusal(
        reorderWorkspaces({
          visibleWorkspaceIds: ['alpha', 'beta'],
          activeWorkspaceId: 'beta',
          overWorkspaceId: 'alpha',
        }),
        'index-unavailable',
        /project list couldn't be read/,
      );
      expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(
        '{"version": 1, "work',
      );
    });
  });
});
