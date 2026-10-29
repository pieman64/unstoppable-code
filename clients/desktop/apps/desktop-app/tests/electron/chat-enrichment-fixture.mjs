import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedCoworkWorkspace,
  seedWorktreeChat,
} from './seeders/index.mjs';

export const LINEAR_TOKEN = 'lin_api_can4060';
export const GITHUB_TOKEN = 'ghp_can4060';
export const LINEAR_URL = 'https://linear.app/acme/issue/CAN-42/the-title';
export const GITHUB_URL = 'https://github.com/acme/app/pull/7/files?w=1#diff-x';
export const TEXT = `References: CAN-42 and acme/app#7.\n\nRaw: ${LINEAR_URL} and ${GITHUB_URL}.\n\nLabels: [my Linear label](${LINEAR_URL}) and [my GitHub label](${GITHUB_URL}).\n\nExcluded: utf-8, #99 and \`CAN-43 acme/app#9\`.\n\n\`\`\`text\nCAN-43 acme/app#9\n\`\`\``;

export function seedEnrichment(root) {
  const userDataDir = path.join(root, 'data');
  mkdirSync(userDataDir, { recursive: true });
  const summary = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const repo = summary.workspaces[0].worktreePath;
  execFileSync('/usr/bin/git', [
    '-C',
    repo,
    'remote',
    'add',
    'origin',
    'https://github.com/acme/app.git',
  ]);
  execFileSync('/usr/bin/git', [
    '-C',
    repo,
    'config',
    'http.proxy',
    'http://127.0.0.1:9',
  ]);
  const worktreeData = path.join(
    userDataDir,
    'workspaces/demo-ts-pnpm-vite/worktree-data/demo-main',
  );
  mkdirSync(worktreeData, { recursive: true });
  writeFileSync(
    path.join(worktreeData, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
  );
  const messages = [
    {
      id: 'enrichment-user',
      role: 'user',
      blocks: [{ type: 'text', text: 'Check references.' }],
      timestamp: Date.parse('2026-10-01T10:00:00Z'),
    },
    {
      id: 'enrichment-answer',
      role: 'assistant',
      blocks: [{ type: 'text', text: TEXT }],
      timestamp: Date.parse('2026-10-01T10:00:05Z'),
    },
  ];
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    activeTabId: 'enrichment-chat',
    tabs: [
      { id: 'enrichment-chat', title: 'Enrichment modes', messages },
      { id: 'enrichment-remaining', title: 'Remaining chat', messages: [] },
    ],
  });
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: 'enrichment-cowork',
    name: 'Enrichment cowork',
    collapsed: false,
    chatId: 'enrichment-cowork-chat',
    chatTitle: 'Cowork modes',
    externalPath: root,
    mergeIndex: true,
  });
  const chatsPath = path.join(
    userDataDir,
    'workspaces/enrichment-cowork/chats/home.json',
  );
  const chats = JSON.parse(readFileSync(chatsPath, 'utf8'));
  chats.tabs[0].messages = messages;
  writeFileSync(chatsPath, JSON.stringify(chats));
  const ghConfig = path.join(root, 'gh-config');
  mkdirSync(ghConfig);
  return {
    userDataDir,
    env: { GH_CONFIG_DIR: ghConfig, GH_HOST: 'github.e2e.invalid' },
  };
}

export async function registerEnrichment() {
  await registerScenario(DEFAULT_MOCK_BASE_URL, LINEAR_TOKEN, {
    linear: {
      previewTeams: [{ id: 'can', key: 'CAN', name: 'Canopy' }],
      issues: [
        {
          id: 'can42',
          identifier: 'CAN-42',
          title: 'Linear enrichment title',
          url: LINEAR_URL,
          state: { name: 'In Review' },
        },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, GITHUB_TOKEN, {
    github: {
      issues: {
        'acme/app/7': {
          number: 7,
          title: 'GitHub enrichment title',
          state: 'open',
          html_url: 'https://github.com/acme/app/pull/7',
          updated_at: '2026-10-01T00:00:00Z',
          user: { login: 'octocat' },
          pull_request: { merged_at: null },
          draft: false,
        },
      },
    },
  });
}

export async function connectEnrichment(window) {
  await window.evaluate(
    async ({ linear, github }) => {
      await window.api.saveLinearToken(linear);
      await window.api.saveGitHubPat(github);
      window.dispatchEvent(new Event('canopy:linear-connection-changed'));
      window.dispatchEvent(new Event('canopy:github-connection-changed'));
    },
    { linear: LINEAR_TOKEN, github: GITHUB_TOKEN },
  );
}

export async function openEnrichmentChat(window, cowork = false) {
  const app = new CanopyAppDriver(window);
  await app.openMainPage();
  if (cowork) {
    const toggle = window.getByTestId(
      'sidebar-cowork-project-enrichment-cowork-toggle',
    );
    if ((await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
    await window
      .getByTestId('sidebar-work-entry-enrichment-cowork-chat')
      .click();
  } else {
    await app.selectWorktree('demo-main');
    await window.getByTestId('panel-tab-panel-chat-enrichment-chat').click();
  }
  const chat = window
    .getByTestId('panel-content-chat')
    .filter({ visible: true });
  await expect(chat).toContainText('References:');
  return chat;
}
