// Every sidebar read re-registers workspace types, ids and external paths
// (CAN-5497). Only a read that can decide a value replaces it: an unreadable
// index or `workspace.json` keeps the last registered projection instead of
// clearing it. Runs the real sidebar-items and workspace-persistence modules
// against a temporary data dir, outside any W5 commit-event path.
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CoworkSidebarItem } from '@canopy/desktop-shared/types';
import {
  getWorkspaceConfigPath,
  getWorkspaceIndexFilePath,
} from '../lib/paths';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import {
  getWorkspaceExternalPath,
  getWorkspaceType,
  listRegisteredWorkspaceIds,
} from '../lib/workspace-registry';

const RESEARCH_ID = 'research';
const NOTES_ID = 'notes';

describe('sidebar reads keep the last good workspace registries', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  const externalDir = (name: string): string =>
    path.join(dataDir, 'external', name);

  function coworkItem(id: string, order: number): CoworkSidebarItem {
    return {
      type: 'cowork',
      id,
      name: `Project ${id}`,
      color: '#7C3AED',
      collapsed: false,
      order,
      cowork: { createdAt: '2026-09-01T00:00:00.000Z' },
      externalPath: externalDir(id),
    };
  }

  function registries(): Array<[string, string | null, string | null]> {
    return listRegisteredWorkspaceIds()
      .sort()
      .map((id) => [id, getWorkspaceType(id), getWorkspaceExternalPath(id)]);
  }

  async function rewriteJson(
    filePath: string,
    update: (document: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error(`Expected a JSON object at ${filePath}`);
    await writeFile(filePath, JSON.stringify(update({ ...parsed })));
  }

  function withoutExternalPath(
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...config };
    delete next.externalPath;
    return next;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-registries-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await mkdir(externalDir(RESEARCH_ID), { recursive: true });
    await mkdir(externalDir(NOTES_ID), { recursive: true });
    await writeAllSidebarItems([
      coworkItem(RESEARCH_ID, 0),
      coworkItem(NOTES_ID, 1),
    ]);
    await readAllSidebarItems();
    expect(registries()).toEqual([
      [NOTES_ID, 'cowork', externalDir(NOTES_ID)],
      [RESEARCH_ID, 'cowork', externalDir(RESEARCH_ID)],
    ]);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps every type, id and external path when the index is unreadable', async () => {
    const before = registries();
    await writeFile(getWorkspaceIndexFilePath(), '{ not json');

    await readAllSidebarItems();

    expect(registries()).toEqual(before);
  });

  it('keeps a workspace’s external path when its workspace.json is unreadable', async () => {
    await writeFile(getWorkspaceConfigPath(RESEARCH_ID), '{ not json');

    await readAllSidebarItems();

    expect(getWorkspaceExternalPath(RESEARCH_ID)).toBe(
      externalDir(RESEARCH_ID),
    );
    expect(getWorkspaceType(RESEARCH_ID)).toBe('cowork');
  });

  it('updates an external path a readable workspace.json changed', async () => {
    const moved = externalDir('moved');
    await mkdir(moved, { recursive: true });
    await rewriteJson(getWorkspaceConfigPath(RESEARCH_ID), (config) => ({
      ...config,
      externalPath: moved,
    }));

    await readAllSidebarItems();

    expect(getWorkspaceExternalPath(RESEARCH_ID)).toBe(moved);
    expect(getWorkspaceExternalPath(NOTES_ID)).toBe(externalDir(NOTES_ID));
  });

  it('clears an external path a readable workspace.json removed', async () => {
    await rewriteJson(getWorkspaceConfigPath(RESEARCH_ID), withoutExternalPath);

    await readAllSidebarItems();

    expect(getWorkspaceExternalPath(RESEARCH_ID)).toBeNull();
  });

  it('forgets a workspace a readable index no longer lists', async () => {
    await rewriteJson(getWorkspaceIndexFilePath(), (index) => ({
      ...index,
      workspaces: Array.isArray(index.workspaces)
        ? index.workspaces.filter(
            (entry: unknown) =>
              typeof entry === 'object' &&
              entry !== null &&
              'id' in entry &&
              entry.id !== NOTES_ID,
          )
        : [],
    }));
    await rm(path.dirname(getWorkspaceConfigPath(NOTES_ID)), {
      recursive: true,
      force: true,
    });

    await readAllSidebarItems();

    expect(registries()).toEqual([
      [RESEARCH_ID, 'cowork', externalDir(RESEARCH_ID)],
    ]);
  });

  it('registers again from the index once it is readable', async () => {
    const index = await readFile(getWorkspaceIndexFilePath(), 'utf8');
    await writeFile(getWorkspaceIndexFilePath(), '{ not json');
    await readAllSidebarItems();
    await rewriteJson(getWorkspaceConfigPath(NOTES_ID), withoutExternalPath);
    await writeFile(getWorkspaceIndexFilePath(), index);

    await readAllSidebarItems();

    expect(registries()).toEqual([
      [NOTES_ID, 'cowork', null],
      [RESEARCH_ID, 'cowork', externalDir(RESEARCH_ID)],
    ]);
  });
});
