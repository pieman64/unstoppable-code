// CAN-3760: every Codex thread inherited the MCP servers configured globally
// in the user's Codex config, and Codex kept those processes alive after the
// thread finished. A Codex chat must disable every ambient server it did not
// select on each thread it starts.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PROMPT = 'Reply without using any tools.';
const FIXTURE_REPLY = 'Ambient isolation reply from the app-server fixture';
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-codex-app-server.mjs',
);
const AMBIENT_MCP_SERVERS = {
  telegram: { command: 'npx', args: ['-y', '@chaindead/telegram-mcp'] },
  node_repl: { command: '/opt/node_repl' },
  already_off: { command: '/opt/off', enabled: false },
};

function seedPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: 'codex',
          defaultChatProvider: 'codex',
          defaultChatInterfaceMode: 'canopy',
          mcpProxyPort: 43000 + (Date.now() % 10000),
          defaultWorktreeModelByProvider: {
            codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          },
          defaultChatModelByProvider: {
            codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function clientRequests(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message);
}

function ambientServerTable(request) {
  return request.params?.config?.mcp_servers ?? {};
}

test.describe('Codex ambient MCP isolation', () => {
  test('a Codex chat disables globally configured MCP servers it did not select', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-ambient-mcp-'),
    );
    const runtimeDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-ambient-runtime-'),
    );
    const canonicalHome = path.join(runtimeDir, 'canonical-home');
    const statePath = path.join(runtimeDir, 'state.json');
    const logPath = path.join(runtimeDir, 'protocol.jsonl');
    mkdirSync(canonicalHome, { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} })}\n`,
      'utf8',
    );
    seedPreferences(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'ambient-chat',
      tabs: [
        {
          id: 'ambient-chat',
          title: 'Ambient isolation',
          providerType: 'codex',
          messages: [],
        },
      ],
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CODEX_EXECUTABLE: FIXTURE_PATH,
        CANOPY_E2E_CODEX_LOG_PATH: logPath,
        CANOPY_E2E_CODEX_STATE_PATH: statePath,
        CANOPY_E2E_CODEX_CANONICAL_HOME: canonicalHome,
        CANOPY_E2E_CODEX_REPLY: FIXTURE_REPLY,
        CANOPY_E2E_CODEX_AMBIENT_MCP_SERVERS:
          JSON.stringify(AMBIENT_MCP_SERVERS),
      },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.fill(PROMPT);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(
        window.getByText(FIXTURE_REPLY, { exact: true }).last(),
      ).toBeVisible({ timeout: 60_000 });

      const requests = clientRequests(logPath);
      const starts = requests.filter(
        (request) => request.method === 'thread/start',
      );
      expect(starts.length).toBeGreaterThan(0);
      for (const start of starts) {
        expect(ambientServerTable(start)).toEqual(
          expect.objectContaining({
            telegram: { enabled: false },
            node_repl: { enabled: false },
          }),
        );
        expect(ambientServerTable(start)).not.toHaveProperty('already_off');
      }
      expect(
        requests.some(
          (request) =>
            request.method === 'config/read' &&
            typeof request.params?.cwd === 'string',
        ),
      ).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
