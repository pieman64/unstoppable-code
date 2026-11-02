import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedMcpServers, seedWorktreeChat } from './seeders/index.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

export async function launchMcpAuthStatusFixture({
  expiresInMs,
  lastError,
  canRefresh = true,
  plainHttp = false,
  secureStorageUnavailable = false,
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-mcp-validity-'),
  );
  const now = new Date().toISOString();
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'aabbcc',
          name: 'Refreshable Account',
          description: 'Account with renewable access',
          type: 'http',
          url: 'https://mcp.example.test/mcp',
          ...(plainHttp ? {} : { oauth: {} }),
          httpAuthHandler: 'canopy',
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: 'ddeeff',
            name: 'Default',
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    activeTabId: 'mcp-validity',
    tabs: [
      {
        id: 'mcp-validity',
        title: 'MCP validity',
        messages: [],
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [{ serverId: 'aabbcc', configId: 'ddeeff' }],
        },
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    if (secureStorageUnavailable) {
      await electronApp.evaluate(({ safeStorage }) => {
        safeStorage.isEncryptionAvailable = () => false;
      });
    } else {
      const encrypted = await electronApp.evaluate(({ safeStorage }) => ({
        access: safeStorage
          .encryptString('fixture-access-token')
          .toString('base64'),
        refresh: safeStorage
          .encryptString('fixture-refresh-token')
          .toString('base64'),
      }));
      writeJson(path.join(`${userDataDir}-secure`, 'mcp-oauth-tokens.json'), {
        version: 1,
        records: {
          'aabbcc:ddeeff': {
            serverId: 'aabbcc',
            configId: 'ddeeff',
            encryptedAccessTokenBase64: encrypted.access,
            encryptedRefreshTokenBase64: canRefresh
              ? encrypted.refresh
              : undefined,
            lastError,
            upstreamUrl: 'https://mcp.example.test/mcp',
            clientId: 'fixture-client',
            tokenUrl: 'https://mcp.example.test/token',
            tokenType: 'Bearer',
            expiresAt: expiresInMs
              ? new Date(Date.now() + expiresInMs).toISOString()
              : '2000-01-01T00:00:00.000Z',
            updatedAt: now,
          },
        },
      });
    }
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    const title = window.getByRole('heading', {
      name: 'MCP servers',
      exact: true,
    });
    await expect(title).toBeVisible();
    const section = title.locator('xpath=ancestor::section[1]');
    const expand = section.locator('[aria-label="Expand section"]');
    if (await expand.count()) await expand.first().click();
    if (!secureStorageUnavailable) {
      await expect(
        section.getByRole('button', {
          name: 'Refreshable Account',
          exact: true,
        }),
      ).toBeVisible();
    }
    return { electronApp, userDataDir, window, app, section };
  } catch (error) {
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    throw error;
  }
}
