import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedPreferences } from '../codexPipelineRuntime.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
  writeJson,
} from './index.mjs';
import { INVOCABLE_INVENTORY_CACHE_VERSION } from './invocableInventoryCache.mjs';

export const SHARE_WORKSPACE = 'demo-ts-pnpm-vite';
export const SHARE_WORKTREE = 'demo-main';
export const SHARE_CHAT = 'skill-share-chat';
export const SHARE_SKILL = 'share-review';
export const SHARE_TARGET = {
  kind: 'skill',
  sourceId: 'custom:app',
  name: SHARE_SKILL,
};
export const SHARE_KEY = JSON.stringify(['skill', 'custom:app', SHARE_SKILL]);

/** Every fixture lives in the harness's temporary application data directory. */
export function seedChatSkillShare(
  userDataDir,
  {
    count = 2,
    transcript = false,
    pluginDisplayName = 'Release tools',
    pluginSkillName = 'plugin-review',
  } = {},
) {
  seedPreferences(userDataDir);
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const skillDir = path.join(userDataDir, 'skills', 'custom:app', SHARE_SKILL);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${SHARE_SKILL}\ndescription: Deterministic share fixture\nuser-invocable: true\n---\n\nReview the requested change.\n`,
  );
  writeJson(path.join(userDataDir, 'invocable-inventory-cache.json'), {
    version: INVOCABLE_INVENTORY_CACHE_VERSION,
    builtAt: '2026-10-03T00:00:00.000Z',
    entries: [
      {
        id: 'codex-share-review',
        provider: 'codex',
        kind: 'skill',
        name: SHARE_SKILL,
        displayName: `/${SHARE_SKILL}`,
        description: 'Deterministic share fixture',
        insertText: `$builtin-app-plugin:${SHARE_SKILL} `,
        invocationKey: `$builtin-app-plugin:${SHARE_SKILL}`,
        enableRef: {
          kind: 'skill',
          sourceId: 'custom:app',
          skillName: SHARE_SKILL,
        },
      },
      {
        id: 'codex-plugin-review',
        provider: 'codex',
        kind: 'plugin_skill',
        name: pluginSkillName,
        displayName: `$release-tools:${pluginSkillName}`,
        description: 'Plugin share fixture',
        insertText: `$release-tools:${pluginSkillName} `,
        invocationKey: `$release-tools:${pluginSkillName}`,
        enableRef: {
          kind: 'plugin',
          marketplaceId: 'demo/market',
          pluginName: 'release-tools',
        },
      },
      // Skill analysis requires the skill for both providers. Appended so
      // specs that address the rows above by index keep working.
      {
        id: 'claude-share-review',
        provider: 'claude',
        kind: 'skill',
        name: SHARE_SKILL,
        displayName: `/${SHARE_SKILL}`,
        description: 'Deterministic share fixture',
        insertText: `/${SHARE_SKILL} `,
        invocationKey: `/${SHARE_SKILL}`,
        enableRef: {
          kind: 'skill',
          sourceId: 'custom:app',
          skillName: SHARE_SKILL,
        },
      },
    ],
  });
  writeJson(path.join(userDataDir, 'plugins-cache.json'), {
    version: 2,
    lastRefreshed: '2026-10-03T00:00:00.000Z',
    lastProviderRefreshAt: '2026-10-03T00:00:00.000Z',
    marketplaces: [
      {
        id: 'demo/market',
        name: 'Demo Market',
        sourceType: 'github',
        sourceUrl: 'demo/market',
        installLocation: '',
        pluginCount: 1,
        validProviders: ['codex'],
        plugins: [
          {
            name: 'release-tools',
            displayName: pluginDisplayName,
            description: 'Release helpers',
            marketplaceId: 'demo/market',
            sourcePath: 'plugins/release-tools',
            facets: { claude: {} },
          },
        ],
      },
    ],
  });
  writeJson(path.join(userDataDir, 'skill-usage.json'), {
    version: 1,
    items: { [SHARE_KEY]: { count } },
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: SHARE_WORKSPACE,
    worktreeId: SHARE_WORKTREE,
    providerType: 'codex',
    tabs: [
      {
        id: SHARE_CHAT,
        title: 'Share skills',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'custom:app', skillName: SHARE_SKILL }],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        messages: transcript
          ? [
              {
                id: 'mention',
                role: 'user',
                timestamp: 1791028800000,
                blocks: [
                  {
                    type: 'text',
                    text: `Use /${SHARE_SKILL} and $release-tools:${pluginSkillName}`,
                  },
                ],
              },
              {
                id: 'artifact-use',
                role: 'assistant',
                timestamp: 1791028800001,
                blocks: [
                  {
                    type: 'tool_use',
                    toolUseId: 'share-artifact',
                    toolName: 'DispatchAction',
                    input: '{}',
                  },
                ],
              },
              {
                id: 'artifact-result',
                role: 'assistant',
                timestamp: 1791028800002,
                blocks: [
                  {
                    type: 'tool_result',
                    toolUseId: 'share-artifact',
                    toolName: 'DispatchAction',
                    isError: false,
                    output: JSON.stringify({
                      ok: true,
                      result: {
                        agentArtifacts: [
                          {
                            version: 1,
                            kind: 'skill',
                            operation: 'skills.create_custom',
                            dedupeKey: `canopy:skill:installed:custom%3Aapp:${SHARE_SKILL}`,
                            createdAt: '2026-10-03T12:00:00.000Z',
                            source: 'installed',
                            sourceId: 'custom:app',
                            installedName: SHARE_SKILL,
                            name: SHARE_SKILL,
                            description: 'Deterministic share fixture',
                            canUpdate: true,
                            navigationTarget: {
                              kind: 'installed_skill',
                              sourceId: 'custom:app',
                              skillName: SHARE_SKILL,
                            },
                          },
                        ],
                      },
                    }),
                  },
                ],
              },
              {
                id: 'timer',
                role: 'system',
                timestamp: 1791028800003,
                blocks: [
                  {
                    type: 'turn_timer',
                    startedAt: 1791028800000,
                    completedAt: 1791028800003,
                  },
                ],
              },
            ]
          : [],
      },
    ],
  });
}

export async function connectChatShareAccount(
  window,
  apiKey = 'csk_chat_skill_share_e2e',
) {
  const result = await window.evaluate(
    (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    apiKey,
  );
  if (!result.status.authenticated)
    throw new Error(result.status.error ?? 'Could not connect fixture account');
  await window.evaluate(() =>
    window.dispatchEvent(new Event('canopy:cloud-account-changed')),
  );
}

export const LAYOUT_ORGANIZATION_ID = '36330000-0000-4000-8000-000000000001';
export const LAYOUT_TEAM_ID = '36330000-0000-4000-8000-000000000002';
export const LAYOUT_TEAM_NAME =
  'Release engineering and deployment readiness across all product teams';

/** Register the seeded skill through its normal editor save path as well. */
export async function ensureChatLayoutSkill(window) {
  const result = await window.evaluate(
    (name) =>
      window.skills.saveCustomSkill({
        name,
        originalName: name,
        description: 'Deterministic share fixture',
        body: 'Review the requested change.',
        extraMetadata: { 'user-invocable': 'true' },
      }),
    SHARE_SKILL,
  );
  if (!result.success)
    throw new Error(result.error ?? 'Could not save fixture skill');
}

/** A keyed local Cloud scenario; shares are created through the real dialogs. */
export async function registerChatLayoutScenario(apiKey) {
  const organization = {
    id: LAYOUT_ORGANIZATION_ID,
    name: 'Release organization',
    role: 'MEMBER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      activityRowShares: { skills: [], plugins: [] },
      organizations: [organization],
      teams: [
        {
          id: LAYOUT_TEAM_ID,
          name: LAYOUT_TEAM_NAME,
          organization,
          createdAt: organization.createdAt,
          updatedAt: organization.updatedAt,
        },
      ],
      orgBillingStates: [
        {
          organizationId: organization.id,
          organizationName: organization.name,
          teamsEntitled: true,
        },
      ],
    },
  });
}

/** The dialog follows the selected context; restore Personal after sharing. */
export async function shareChatLayoutResource(window, row, kind, audience) {
  await row.getByTestId('chat-used-invocable-share').click();
  const modal = window.getByTestId(`share-${kind}-modal`);
  await modal.waitFor({ state: 'visible' });
  if (audience !== 'public')
    await window.evaluate(async (organizationId) => {
      const current = await window.api.workspaceContext.get();
      await window.api.workspaceContext.set({
        context: { kind: 'organization', organizationId },
        expectedRevision: current.revision,
      });
    }, LAYOUT_ORGANIZATION_ID);
  const scope = modal.getByTestId(`share-${kind}-scope-${audience}`);
  if (await scope.count()) await scope.click({ timeout: 15_000 });
  if (audience !== 'public') {
    const targetId =
      audience === 'team' ? LAYOUT_TEAM_ID : LAYOUT_ORGANIZATION_ID;
    await modal
      .getByTestId(`share-${kind}-${audience}-picker-option-${targetId}`)
      .click();
  }
  await modal.getByTestId(`share-${kind}-submit`).click({ timeout: 15_000 });
  // A landed share keeps the dialog open on its success notice until Done.
  await modal
    .getByTestId(`share-${kind}-success`)
    .waitFor({ state: 'visible', timeout: 15_000 });
  await modal.getByTestId(`share-${kind}-done`).click();
  await modal.waitFor({ state: 'hidden' });
  if (audience !== 'public')
    await window.evaluate(async () => {
      const current = await window.api.workspaceContext.get();
      await window.api.workspaceContext.set({
        context: { kind: 'personal' },
        expectedRevision: current.revision,
      });
    });
  // Context changes return to Home; reopen the seeded chat after restoring it.
  const { CanopyAppDriver } = await import('../canopyApp.mjs');
  const app = new CanopyAppDriver(window);
  await app.openMainPage();
  await app.selectWorktree(SHARE_WORKTREE);
  await row
    .getByTestId('chat-used-invocable-audience')
    .waitFor({ state: 'visible' });
  const toasts = window.getByTestId('toast-card');
  while (await toasts.count()) {
    await toasts
      .first()
      .getByRole('button', { name: 'Dismiss', exact: true })
      .click();
  }
}

/** Resize with the production sash, including its 320 CSS-pixel floor. */
export async function resizeChatActivityRail(window, width) {
  const group = window.getByTestId('panel-group-group-activity');
  const bounds = await group.boundingBox();
  if (!bounds) throw new Error('Activity group is not visible');
  const sashes = window.locator('.canopy-sash.vertical:visible');
  for (const sash of await sashes.all()) {
    const handle = await sash.boundingBox();
    if (!handle || Math.abs(handle.x + handle.width / 2 - bounds.x) > 8)
      continue;
    await window.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(
      handle.x + handle.width / 2 + bounds.width - width,
      handle.y + handle.height / 2,
      { steps: 12 },
    );
    await window.mouse.up();
    return;
  }
  throw new Error('Activity resize sash was not found');
}

/** Unresolved plugin usage, shared by durable coverage and visual captures. */
export function seedUnresolvedChatSkillShare(userDataDir) {
  seedChatSkillShare(userDataDir);
  writeJson(path.join(userDataDir, 'invocable-inventory-cache.json'), {
    version: INVOCABLE_INVENTORY_CACHE_VERSION,
    builtAt: '2026-10-03T00:00:00.000Z',
    entries: [
      {
        id: 'unresolved-plugin',
        provider: 'codex',
        kind: 'plugin_skill',
        name: 'review',
        displayName: '$unresolved:review',
        description: '',
        invocationKey: '$unresolved:review',
        insertText: '$unresolved:review ',
        enableRef: {
          kind: 'plugin',
          marketplaceId: 'unresolved/local',
          pluginName: 'Unresolved plugin',
        },
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: SHARE_WORKSPACE,
    worktreeId: SHARE_WORKTREE,
    providerType: 'codex',
    tabs: [
      {
        id: SHARE_CHAT,
        title: 'Unresolved usage',
        messages: [
          {
            id: 'usage',
            role: 'user',
            timestamp: 1791028800000,
            blocks: [{ type: 'text', text: '$unresolved:review' }],
          },
        ],
      },
    ],
  });
}
