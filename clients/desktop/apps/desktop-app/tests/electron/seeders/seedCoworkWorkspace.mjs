import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Seed one cowork workspace (`workspace.json.type === 'cowork'`) into a test's
 * `userDataDir` with a single persisted chat, matching the post-migration
 * unified `workspaces/` layout the main process reads:
 * `workspaces/index.json` (sidebar entry), `workspaces/{id}/workspace.json`
 * (cowork config), `workspaces/{id}/chats/home.json` (legacy pre-entry chat
 * slot) and `workspaces/{id}/chat-history/{chatId}/meta.json` (persisted chat
 * listing). See the `SidebarCoworkWorkspaceRow` readers and
 * docs/cowork-workspaces.md.
 *
 * @param {object} options
 * @param {string} options.userDataDir test-scoped CANOPY_DATA_DIR
 * @param {string} [options.workspaceId]
 * @param {string} [options.name]
 * @param {string} [options.color]
 * @param {boolean} [options.collapsed] sidebar row starts collapsed
 * @param {string} [options.chatId]
 * @param {string} [options.chatTitle]
 * @param {string} [options.externalPath] attach an existing external folder
 *   as the working directory instead of the managed `home/`
 * @param {'codex' | 'claude'} [options.providerType] the seeded chat's provider
 * @param {string | null} [options.defaultModel] the workspace's default model;
 *   `null` omits it so the app default applies
 * @param {boolean} [options.seedMessage] seed one user message; `false`
 *   leaves the chat empty
 * @param {string} [options.seededFromBlueprintExternalId] curated project
 *   template seed provenance (`WorkspaceConfigFile.seededFromBlueprintExternalId`,
 *   CAN-2964); pair with `seedBlueprintCatalog` so the template resolves
 * @param {Array<{ id: string, text: string }>} [options.starterPrompts] the
 *   project's own starter prompts (`CoworkWorkspaceSettings.starterPrompts`);
 *   omit to fall back to the seeding template's
 * @param {object} [options.defaultPluginSelections] the project's default
 *   plugin selections (`ChatTabPluginSelections`), where a template's
 *   resolved refs land at seed time
 * @param {boolean} [options.mergeIndex] append to an existing
 *   `workspaces/index.json` instead of replacing it, for multi-project fixtures
 */
export function seedCoworkWorkspace({
  userDataDir,
  workspaceId = 'seeded-cowork',
  name = 'Seeded Cowork',
  color = '#7C9B6D',
  collapsed = true,
  chatId = 'seeded-cowork-chat',
  chatTitle = 'Seeded Cowork Chat',
  externalPath,
  providerType = 'codex',
  defaultModel = 'gpt-6-luna',
  seedMessage = true,
  seededFromBlueprintExternalId,
  starterPrompts,
  defaultPluginSelections,
  mergeIndex = false,
}) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const createdAt = '2026-05-01T12:00:00.000Z';

  const indexPath = path.join(workspacesRoot, 'index.json');
  const existing =
    mergeIndex && existsSync(indexPath)
      ? JSON.parse(readFileSync(indexPath, 'utf8')).workspaces.filter(
          (entry) => entry.id !== workspaceId,
        )
      : [];
  writeJson(indexPath, {
    version: 1,
    workspaces: [
      ...existing,
      {
        id: workspaceId,
        name,
        type: 'cowork',
        color,
        collapsed,
        order: existing.length,
      },
    ],
  });

  const workspaceDir = path.join(workspacesRoot, workspaceId);
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    ...(externalPath !== undefined ? { externalPath } : {}),
    ...(defaultPluginSelections !== undefined
      ? { defaultPluginSelections }
      : {}),
    ...(seededFromBlueprintExternalId !== undefined
      ? { seededFromBlueprintExternalId }
      : {}),
    cowork: {
      createdAt,
      ...(defaultModel !== null ? { defaultModel } : {}),
      ...(starterPrompts !== undefined ? { starterPrompts } : {}),
      searchIndexingEnabled: true,
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspaceDir, 'chats', 'home.json'), {
    version: 1,
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: chatTitle,
        description: `${chatTitle} conversation`,
        createdAt,
        providerType,
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        messages: seedMessage
          ? [
              {
                id: `${chatId}-user-1`,
                role: 'user',
                blocks: [{ type: 'text', text: 'Hello from the seeded chat.' }],
                timestamp: Date.parse('2026-05-01T12:01:00.000Z'),
              },
            ]
          : [],
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'chat-history', chatId, 'meta.json'), {
    version: 1,
    id: chatId,
    title: chatTitle,
    description: `${chatTitle} conversation`,
    createdAt,
    messageCount: seedMessage ? 1 : 0,
    lastMessageAt: createdAt,
    providerType,
    archived: false,
  });

  return { workspaceId, chatId };
}
