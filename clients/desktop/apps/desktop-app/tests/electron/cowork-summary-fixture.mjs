import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerScenario } from './seeders/registerScenario.mjs';

export const HOME_COWORK_PROMPT =
  '[home-cowork-legacy] Start a fresh investigation';
export async function registerHomeCoworkScenario(baseUrl) {
  await registerScenario(baseUrl, 'home-cowork-legacy', {
    llm: {
      steps: [
        { text: 'Ready to investigate.', stopReason: 'end_turn', streamMs: 50 },
      ],
    },
  });
}

export const WORKSPACE_ID = 'cowork-default';
export const ENTRY_COUNT = 50;
export const OPEN_INDEXES = [0, 24, 49];

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function ordinal(index) {
  return String(index + 1).padStart(3, '0');
}

export function entryId(index) {
  return `summary-entry-${ordinal(index)}`;
}

export function seedScaleFixture(userDataDir, { legacySummary = false } = {}) {
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Personal',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: {
      createdAt: '2026-08-17T12:00:00.000Z',
      archiveRetentionDays: null,
    },
  });

  const entries = Array.from({ length: ENTRY_COUNT }, (_, index) => {
    const label = ordinal(index);
    const createdAt = new Date(
      Date.parse('2026-08-17T12:00:00.000Z') + index * 60_000,
    ).toISOString();
    const lastMessageAt = new Date(
      Date.parse('2026-08-17T13:00:00.000Z') + index * 60_000,
    ).toISOString();
    return {
      id: entryId(index),
      createdAt,
      summary: {
        version: 1,
        sourceMtimeNs: 'missing',
        title: `Customer investigation ${label}`,
        lastMessageAt,
        providerType: index % 2 === 0 ? 'codex' : 'claude',
        chatCount: 3,
        chats: ['Overview', 'Long transcript', 'Pipeline review'].map(
          (kind, tabIndex) => ({
            id: `${entryId(index)}-chat-${tabIndex + 1}`,
            title: `${kind} ${label}`,
            description: `${kind} ${label}`,
            createdAt,
            lastMessageAt,
            providerType: index % 2 === 0 ? 'codex' : 'claude',
          }),
        ),
      },
    };
  });
  for (const index of OPEN_INDEXES) {
    const label = ordinal(index);
    const id = entryId(index);
    const tabs = ['Overview', 'Long transcript', 'Pipeline review'].map(
      (kind, tabIndex) => ({
        id: `${id}-chat-${tabIndex + 1}`,
        title: `${kind} ${label}`,
        description: `${kind} ${label}`,
        createdAt: '2026-08-17T12:00:00.000Z',
        kind: 'chat',
        providerType: tabIndex === 1 ? 'claude' : 'codex',
        messages: Array.from(
          { length: tabIndex === 1 ? 80 : 8 },
          (_, messageIndex) => ({
            id: `${id}-${tabIndex}-${messageIndex}`,
            role: messageIndex % 2 === 0 ? 'user' : 'assistant',
            blocks: [
              {
                type: 'text',
                text: `${kind} ${label} message ${messageIndex + 1} ${'transcript content '.repeat(
                  tabIndex === 1 ? 40 : 4,
                )}`,
              },
            ],
            timestamp:
              Date.parse('2026-08-17T12:00:00.000Z') + messageIndex * 1_000,
          }),
        ),
      }),
    );
    const chatFilePath = path.join(workspaceDir, 'chats', `${id}.json`);
    writeJson(chatFilePath, {
      version: 1,
      activeTabId: tabs[0].id,
      tabs,
    });
    entries[index].summary.sourceMtimeNs = statSync(chatFilePath, {
      bigint: true,
    }).mtimeNs.toString();
  }

  if (legacySummary) {
    delete entries[24].summary;
    // An apparently empty live tab with archived history must also be rejected
    // as a reuse candidate without admitting its scope into native storage.
    const archiveId = entryId(12);
    const archiveChatPath = path.join(
      workspaceDir,
      'chats',
      `${archiveId}.json`,
    );
    const old = JSON.parse(
      readFileSync(
        path.join(workspaceDir, 'chats', `${entryId(24)}.json`),
        'utf8',
      ),
    );
    old.tabs = old.tabs.map((tab, index) => ({
      ...tab,
      id: `${archiveId}-chat-${index}`,
    }));
    writeJson(path.join(workspaceDir, 'chat-archives', `${archiveId}.json`), {
      version: 1,
      archived: [
        {
          tab: old.tabs[1],
          archivedAt: '2026-08-18T12:00:00.000Z',
          turnCount: 40,
        },
      ],
    });
    writeJson(archiveChatPath, {
      version: 1,
      activeTabId: old.tabs[0].id,
      tabs: [{ ...old.tabs[0], messages: [] }],
    });
    delete entries[12].summary;
  }
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries,
  });
}
