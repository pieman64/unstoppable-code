import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { launchCanopy } from './launchCanopy.mjs';

export const CLOUD_TOOL_CASES = [
  {
    name: 'read',
    input: { filePath: '/repo/src/agent.ts' },
    label: 'Read agent.ts',
    family: 'read',
  },
  {
    name: 'write',
    input: { filePath: '/repo/src/created.ts', content: 'export {};' },
    label: 'Write created.ts',
    family: 'write',
  },
  {
    name: 'edit',
    input: {
      filePath: '/repo/src/edited.ts',
      oldString: 'before',
      newString: 'after',
    },
    label: 'Edit edited.ts',
    family: 'edit',
  },
  {
    name: 'grep',
    input: { pattern: 'needle', path: 'src' },
    label: 'Grep needle in src',
    family: 'grep',
  },
  {
    name: 'glob',
    input: { pattern: '**/*.ts' },
    label: 'Glob **/*.ts',
    family: 'glob',
  },
  {
    name: 'webSearch',
    input: { query: 'cloud agent tools' },
    label: 'Web search cloud agent tools',
    family: 'web',
  },
  {
    name: 'bash',
    input: { command: 'cat package.json' },
    label: 'Read package.json',
    family: 'read',
  },
  {
    name: 'bash',
    input: { command: "sed -n '2,8p' src/agent.ts" },
    label: /Read lines agent\.ts\s*2 to 8/,
    family: 'read',
  },
  {
    name: 'bash',
    input: { command: 'npm test' },
    label: 'Bash npm test',
    family: 'bash',
  },
  {
    name: 'bash',
    input: { command: 'cat *.ts' },
    label: 'Bash cat *.ts',
    family: 'bash',
  },
  {
    name: 'bash',
    input: { command: "sed -n '2,8p' src/*.ts" },
    label: "Bash sed -n '2,8p' src/*.ts",
    family: 'bash',
  },
  {
    name: 'bash',
    input: 'cat package.json',
    label: 'Read package.json',
    family: 'read',
  },
  {
    name: 'bash',
    input: 'npm test',
    label: 'Bash npm test',
    family: 'bash',
  },
  {
    name: 'vendor_custom_tool',
    input: { command: 'cat secret.txt' },
    label: 'Vendor Custom Tool',
    family: 'unknown',
  },
];

export async function openCloudToolDisplayFixture() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cloud-tool-display-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const timestamp = Date.parse('2026-09-16T12:00:00.000Z');
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    activeTabId: 'cloud-tool-display',
    tabs: [
      {
        id: 'cloud-tool-display',
        title: 'Cloud tool display',
        providerType: 'claude',
        messages: [
          {
            id: 'cloud-tool-user',
            role: 'user',
            blocks: [
              { type: 'text', text: 'Inspect the cloud agent tool results.' },
            ],
            timestamp,
          },
          {
            id: 'cloud-tool-assistant',
            role: 'assistant',
            blocks: CLOUD_TOOL_CASES.flatMap(({ name, input }, index) => [
              {
                type: 'tool_use',
                toolUseId: `cloud-tool-${index}`,
                toolName: name,
                input:
                  typeof input === 'string' ? input : JSON.stringify(input),
              },
              {
                type: 'tool_result',
                toolUseId: `cloud-tool-${index}`,
                toolName: name,
                output: `Cloud result ${index}`,
                isError: false,
              },
            ]),
            timestamp: timestamp + 1_000,
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree('demo-main');
  const panel = window.locator(
    '[data-testid="panel-content-chat"][data-panel-id="panel-chat-cloud-tool-display"]',
  );
  return { electronApp, userDataDir, window, panel };
}
