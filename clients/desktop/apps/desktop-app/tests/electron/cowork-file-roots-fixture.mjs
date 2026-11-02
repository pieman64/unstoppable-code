import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';

export const COWORK_FILES_WORKSPACE = 'cowork-project-spend';
export const COWORK_FILES_ENTRY = 'spend-entry';
export const COWORK_FILES_NAME = 'Vendor Spend Q3';
export const COWORK_FILES_BRAND = loadBrand(
  process.env.CANOPY_BRAND ?? 'canopy',
);

/** Seed only disposable data: the attached folder has a different basename. */
export function seedCoworkFileRoots(
  userDataDir,
  {
    workspaceId = COWORK_FILES_WORKSPACE,
    entryId = COWORK_FILES_ENTRY,
    name = COWORK_FILES_NAME,
    otherWorkspaces = [],
  } = {},
) {
  const workspace = path.join(userDataDir, 'workspaces', workspaceId);
  const home = path.join(
    userDataDir,
    'external-fixture',
    workspaceId === COWORK_FILES_WORKSPACE
      ? 'attached-vendor-folder'
      : workspaceId,
  );
  const managed = path.join(
    home,
    COWORK_FILES_BRAND.storage.projectConfigDirNames[0],
  );
  const write = (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const json = (file, value) => write(file, `${JSON.stringify(value)}\n`);
  const createdAt = '2026-07-01T10:00:00.000Z';
  const chatId =
    entryId === COWORK_FILES_ENTRY ? 'spend-chat' : `${entryId}-chat`;
  json(path.join(userDataDir, 'workspaces/index.json'), {
    version: 1,
    workspaces: [
      {
        id: workspaceId,
        type: 'cowork',
        name,
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
      },
      ...otherWorkspaces,
    ],
  });
  json(path.join(workspace, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    externalPath: home,
    cowork: { createdAt, archiveRetentionDays: null },
  });
  json(path.join(workspace, 'work-entries.json'), {
    version: 1,
    entries: [{ id: entryId, createdAt }],
  });
  json(path.join(workspace, 'chats', `${entryId}.json`), {
    version: 1,
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Spend review',
        kind: 'chat',
        createdAt,
        messages: [
          {
            id: 'spend-message',
            role: 'user',
            blocks: [
              { type: 'text', text: 'Review the attached vendor spend.' },
            ],
            timestamp: Date.parse(createdAt),
          },
        ],
      },
    ],
  });
  write(
    path.join(home, 'vendor-spend-cleaned.csv'),
    'vendor,total\nAcme,4791\n',
  );
  write(path.join(home, 'notes', 'user-note.md'), '# User-owned notes\n');
  write(path.join(home, 'prompts', 'user-prompt.md'), '# User-owned prompts\n');
  write(
    path.join(managed, 'notes', 'meeting.md'),
    '# App-owned meeting notes\n',
  );
  write(
    path.join(managed, 'prompts', 'review.md'),
    '# App-owned review prompt\n',
  );
  write(
    path.join(managed, 'attachments', 'brief.txt'),
    'App-owned attachment\n',
  );
  return { home, managed };
}
