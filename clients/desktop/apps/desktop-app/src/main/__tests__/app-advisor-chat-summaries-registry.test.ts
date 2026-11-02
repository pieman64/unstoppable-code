// The App Advisor post-commit projection against the real Work Entry registry
// under a temp CANOPY_DATA_DIR: an unreadable registry must reject so the
// projection retries, while a missing registry or deleted entry settles.

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    payload,
  })),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: jest.fn(() => true),
}));

jest.mock('../services/portal-chat-tabs-cache', () => ({
  portalChatTabsCache: {
    read: jest.fn(() =>
      Promise.resolve({
        version: 1,
        activeTabId: 'advisor-chat',
        tabs: [
          {
            id: 'advisor-chat',
            title: 'Chat',
            messages: [],
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
    ),
  },
}));

jest.mock('../agents/session-manager', () => ({
  getSession: jest.fn(),
  getActiveSessionInfos: jest.fn(() => []),
}));

jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: jest.fn(() => ({
    getWorktreeSnapshots: jest.fn(() => []),
  })),
}));

jest.mock('../ipc/app-advisor', () => ({
  getLatestAppAdvisorWindowUiState: jest.fn(() => ({})),
  listPendingAppAdvisorAskUserQuestions: jest.fn(() => []),
  listAnsweredAppAdvisorAskUserQuestions: jest.fn(() => []),
}));

jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    list: jest.fn(() => Promise.resolve([])),
  })),
}));

import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  createWorkEntry,
  removeWorkEntryRow,
} from '../lib/cowork-work-entries';
import { getWorkspaceWorkEntriesFilePath } from '../lib/paths';
import {
  projectAppAdvisorChatSummaries,
  projectAppAdvisorChatSummariesStrict,
} from '../services/chat-service';
import { enqueuePortalEvent } from '../portal/portal-event-bus';

const mockedEnqueuePortalEvent = jest.mocked(enqueuePortalEvent);

let tempDataDir = '';
const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;

beforeAll(() => {
  tempDataDir = mkdtempSync(join(tmpdir(), 'canopy-app-advisor-registry-'));
  process.env.CANOPY_DATA_DIR = tempDataDir;
});

afterAll(() => {
  if (originalCanopyDataDir === undefined) {
    delete process.env.CANOPY_DATA_DIR;
  } else {
    process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
  }
  rmSync(tempDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockedEnqueuePortalEvent.mockClear();
});

describe('App Advisor post-commit projection registry reads', () => {
  it('rejects an unreadable registry so the projection retries, and projects once it reads', async () => {
    const { entry } = await createWorkEntry(APP_ADVISOR_PROJECT_ID, {
      title: 'Registry read',
    });
    const registryPath = getWorkspaceWorkEntriesFilePath(
      APP_ADVISOR_PROJECT_ID,
    );
    const registry = await readFile(registryPath, 'utf8');
    try {
      await writeFile(registryPath, '{broken', 'utf8');
      // A lenient empty registry would settle as "entry deleted".
      await expect(
        projectAppAdvisorChatSummariesStrict(entry.id),
      ).rejects.toThrow();
      // Best-effort callers keep swallowing the failure.
      await expect(
        projectAppAdvisorChatSummaries(entry.id),
      ).resolves.toBeUndefined();
      expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();

      await writeFile(registryPath, registry, 'utf8');
      await projectAppAdvisorChatSummariesStrict(entry.id);
      expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(1);
      expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
        payload: {
          scope: 'app_advisor',
          entities: [
            {
              entityType: 'app_advisor_chat',
              localId: 'advisor-chat',
              payload: {
                workEntryId: entry.id,
                workEntryTitle: 'Registry read',
              },
            },
          ],
        },
      });
    } finally {
      await writeFile(registryPath, registry, 'utf8');
      await removeWorkEntryRow(APP_ADVISOR_PROJECT_ID, entry.id);
    }
  });

  it('settles without projecting when the registry is missing or the entry is deleted', async () => {
    const { entry } = await createWorkEntry(APP_ADVISOR_PROJECT_ID, {
      title: 'Deleted entry',
    });
    await removeWorkEntryRow(APP_ADVISOR_PROJECT_ID, entry.id);
    await expect(
      projectAppAdvisorChatSummariesStrict(entry.id),
    ).resolves.toBeUndefined();

    await rm(getWorkspaceWorkEntriesFilePath(APP_ADVISOR_PROJECT_ID), {
      force: true,
    });
    await expect(
      projectAppAdvisorChatSummariesStrict('entry-never-created'),
    ).resolves.toBeUndefined();
    expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
  });
});
