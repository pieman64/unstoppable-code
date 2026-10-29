import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
} from './seeders/index.mjs';
import {
  connectEnrichment,
  GITHUB_TOKEN,
  GITHUB_URL,
  LINEAR_URL,
  openEnrichmentChat,
  registerEnrichment,
  seedEnrichment,
} from './chat-enrichment-fixture.mjs';

async function githubReads() {
  const { activity } = await getScenarioActivity(
    DEFAULT_MOCK_BASE_URL,
    GITHUB_TOKEN,
  );
  return activity['githubIssue:acme/app/7'] ?? 0;
}

async function selectMode(window, provider, mode) {
  await window
    .getByRole('combobox', { name: `${provider} chat enrichment` })
    .selectOption(mode.toLowerCase());
}

test('all provider modes preserve prose across cowork, worktree and reload', async () => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(os.tmpdir(), 'can4060-modes-'));
  const fixture = seedEnrichment(root);
  await registerEnrichment();
  const { electronApp } = await launchCanopy(fixture);
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('display');
    await expect(
      window.getByRole('combobox', { name: 'Linear chat enrichment' }),
    ).toHaveValue('replace');
    await expect(
      window.getByRole('combobox', { name: 'GitHub chat enrichment' }),
    ).toHaveValue('hover');
    await selectMode(window, 'Linear', 'Hover');
    await app.openSettingsSection('terminal');
    await app.openSettingsSection('display');
    await expect(
      window.getByRole('combobox', { name: 'Linear chat enrichment' }),
    ).toHaveValue('hover');
    await app.closeSettings();
    await connectEnrichment(window);
    let chat = await openEnrichmentChat(window);
    await expect(chat.getByTestId('github-reference')).toHaveText([
      'acme/app#7',
      GITHUB_URL,
      'my GitHub label',
      '#99',
    ]);
    await expect(chat.getByTestId('linear-reference')).toHaveText([
      'CAN-42',
      LINEAR_URL,
      'my Linear label',
    ]);
    await expect(
      chat.getByTestId('github-reference').locator('svg'),
    ).toHaveCount(0);
    expect(await githubReads()).toBe(0);
    const raw = chat.getByTestId('github-reference').nth(1);
    const width = (await raw.boundingBox()).width;
    await window.keyboard.press('Shift');
    await raw.focus();
    await expect(window.getByRole('tooltip')).toContainText(
      'GitHub enrichment title',
    );
    expect((await raw.boundingBox()).width).toBe(width);
    await window.evaluate(() =>
      window.api.savePreferences({ githubChatEnrichmentMode: 'off' }),
    );
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    await expect(chat.getByTestId('github-reference')).toHaveCount(0);
    await window.evaluate(() =>
      window.api.savePreferences({ githubChatEnrichmentMode: 'hover' }),
    );
    await expect(chat.getByTestId('github-reference')).toHaveCount(4);
    expect(await githubReads()).toBe(1);
    await chat.getByTestId('linear-reference').first().hover();
    await expect(window.getByRole('tooltip')).toContainText(
      'Linear enrichment title',
    );
    await window.evaluate(() =>
      window.api.savePreferences({ linearChatEnrichmentMode: 'off' }),
    );
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    await window.mouse.move(0, 0);
    await window.evaluate(() =>
      window.api.savePreferences({ linearChatEnrichmentMode: 'hover' }),
    );

    for (const linear of ['replace', 'hover', 'off']) {
      for (const github of ['replace', 'hover', 'off']) {
        await window.evaluate(
          async ({ linear, github }) => {
            await window.api.savePreferences({
              linearChatEnrichmentMode: linear,
              githubChatEnrichmentMode: github,
            });
          },
          { linear, github },
        );
        for (const cowork of [false, true]) {
          chat = await openEnrichmentChat(window, cowork);
          for (const [provider, mode, id, url, title] of [
            ['linear', linear, 'CAN-42', LINEAR_URL, 'Linear enrichment title'],
            [
              'github',
              github,
              'acme/app#7',
              GITHUB_URL,
              'GitHub enrichment title',
            ],
          ]) {
            const refs = chat.getByTestId(`${provider}-reference`);
            if (mode === 'off') {
              await expect(refs).toHaveCount(0);
              await expect(chat.locator(`a[href="${url}"]`)).toHaveCount(2);
            } else {
              const labels =
                mode === 'hover'
                  ? [
                      id,
                      url,
                      `my ${provider === 'linear' ? 'Linear' : 'GitHub'} label`,
                    ]
                  : [
                      `${id}: ${title}`,
                      `${provider === 'github' ? (cowork ? id : '#7') : id}: ${title}`,
                      `my ${provider === 'linear' ? 'Linear' : 'GitHub'} label`,
                    ];
              if (provider === 'github' && !cowork) labels.push('#99');
              await expect(refs).toHaveText(labels);
              await expect(refs.locator('svg')).toHaveCount(
                mode === 'hover' ? 0 : labels.length,
              );
            }
          }
          await expect(
            chat.locator('code').filter({ hasText: 'CAN-43' }).first(),
          ).toContainText('CAN-43 acme/app#9');
          await expect(chat.locator('a a')).toHaveCount(0);
        }
      }
    }
    expect(await githubReads()).toBe(1);
    await window.evaluate(() =>
      window.api.savePreferences({
        linearChatEnrichmentMode: 'off',
        githubChatEnrichmentMode: 'hover',
      }),
    );
    await window.addInitScript(() => {
      const record = { replaced: false };
      window.__can4060Startup = record;
      new MutationObserver(() => {
        if (
          document.querySelector(
            '[data-testid="linear-reference"], [data-testid="github-reference-title"], [data-testid="github-reference-title-placeholder"]',
          )
        )
          record.replaced = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await window.reload();
    await app.waitForShell();
    chat = await openEnrichmentChat(window);
    await expect(chat.getByTestId('linear-reference')).toHaveCount(0);
    await expect(chat.getByTestId('github-reference')).toHaveText([
      'acme/app#7',
      GITHUB_URL,
      'my GitHub label',
      '#99',
    ]);
    await expect(chat.getByTestId('github-reference-title')).toHaveCount(0);
    expect(await window.evaluate(() => window.__can4060Startup.replaced)).toBe(
      false,
    );
    expect(await githubReads()).toBe(1);

    const secondaryReady = electronApp.waitForEvent('window');
    await window
      .getByTestId('panel-tab-panel-chat-enrichment-chat')
      .click({ button: 'right' });
    await window.getByTestId('panel-tab-context-new-window').click();
    const secondary = await secondaryReady;
    await expect(secondary.getByTestId('panel-aux-window-root')).toBeVisible();
    const secondChat = secondary
      .getByTestId('panel-content-chat')
      .filter({ visible: true });
    await expect(secondChat).toContainText('References:');
    await expect(secondChat.getByTestId('linear-reference')).toHaveCount(0);
    await expect(secondChat.getByTestId('github-reference')).toHaveText([
      'acme/app#7',
      GITHUB_URL,
      'my GitHub label',
      '#99',
    ]);
    await window.evaluate(() =>
      window.api.savePreferences({ githubChatEnrichmentMode: 'off' }),
    );
    await expect(secondChat.getByTestId('github-reference')).toHaveCount(0);
    await window.evaluate(() =>
      window.api.savePreferences({ githubChatEnrichmentMode: 'replace' }),
    );
    await expect(
      secondChat.getByTestId('github-reference-title').first(),
    ).toContainText('GitHub enrichment title');
  } finally {
    await closeCanopy(electronApp, fixture.userDataDir);
    rmSync(root, { recursive: true, force: true });
  }
});
