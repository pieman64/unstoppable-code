import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Seed the deterministic two-entry Cowork workspace used by the unread-preview
 * regression capture. The shape mirrors the Cowork workspace/index and chat
 * readers exercised by SidebarCoworkWorkspaceRow.
 *
 * @param {string} userDataDir test-scoped CANOPY_DATA_DIR
 */
export function seedUnreadPreviewWorkspace(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'workspaces', 'cowork-default');
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: 'cowork-default',
        name: 'Personal',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: {
          createdAt: '2026-07-01T10:00:00.000Z',
          archiveRetentionDays: null,
        },
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt: '2026-07-01T10:00:00.000Z',
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [
      { id: 'entry-alpha', createdAt: '2026-07-01T10:00:00.000Z' },
      { id: 'entry-beta', createdAt: '2026-07-02T10:00:00.000Z' },
    ],
  });
  writeJson(path.join(workspaceDir, 'chats', 'entry-alpha.json'), {
    version: 1,
    activeTabId: 'chat-alpha',
    tabs: [
      {
        id: 'chat-alpha',
        title: 'New Chat',
        description: 'Alpha planning session',
        createdAt: '2026-07-01T10:05:00.000Z',
        kind: 'chat',
        unread: true,
        messages: [
          {
            id: 'chat-alpha-m1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Draft the alpha plan.' }],
            timestamp: Date.parse('2026-07-01T10:05:00.000Z'),
          },
          {
            id: 'chat-alpha-m2',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Alpha plan drafted and ready.' }],
            timestamp: Date.parse('2026-07-01T10:06:00.000Z'),
          },
        ],
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'chats', 'entry-beta.json'), {
    version: 1,
    activeTabId: 'chat-beta',
    tabs: [
      {
        id: 'chat-beta',
        title: 'New Chat',
        description: 'Beta research session',
        createdAt: '2026-07-02T10:05:00.000Z',
        kind: 'chat',
        messages: [
          {
            id: 'chat-beta-m1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Collect the beta findings.' }],
            timestamp: Date.parse('2026-07-02T10:05:00.000Z'),
          },
        ],
      },
    ],
  });
}
